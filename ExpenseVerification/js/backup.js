/**
 * backup.js — GitHub REST API encrypted backup & restore
 * Pushes AES-256 encrypted JSON snapshots to a GitHub repository.
 * Never transmits plain data — only Encryption.encryptToBlob() output.
 */

const Backup = (() => {

  const BACKUP_DIR = 'backups';

  /* ── Load GitHub config from IndexedDB ──────────────────── */
  async function getConfig() {
    const [token, repo, branch, encKey] = await Promise.all([
      Database.getSetting('ghToken',  ''),
      Database.getSetting('ghRepo',   ''),
      Database.getSetting('ghBranch', 'main'),
      Database.getSetting('ghEncKey', ''),
    ]);
    return { token, repo, branch, encKey };
  }

  /* ── GitHub API base call ────────────────────────────────── */
  async function ghFetch(path, opts = {}, token, repo) {
    const url = `https://api.github.com/repos/${repo}${path}`;
    const res = await fetch(url, {
      ...opts,
      headers: {
        Authorization: `token ${token}`,
        Accept:        'application/vnd.github.v3+json',
        'Content-Type':'application/json',
        ...(opts.headers || {}),
      },
    });
    return res;
  }

  /* ── Test connection ─────────────────────────────────────── */
  async function testConnection(token, repo) {
    const res = await ghFetch('', {}, token, repo);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `HTTP ${res.status}`);
    }
    const data = await res.json();
    return { name: data.full_name, private: data.private, defaultBranch: data.default_branch };
  }

  /* ── Get file SHA (needed for update) ───────────────────── */
  async function getFileSha(path, token, repo, branch) {
    const res = await ghFetch(`/contents/${path}?ref=${encodeURIComponent(branch)}`, {}, token, repo);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    const data = await res.json();
    return data.sha || null;
  }

  /* ── Push a file to GitHub ───────────────────────────────── */
  async function pushFile(filePath, content, message, token, repo, branch) {
    const sha     = await getFileSha(filePath, token, repo, branch);
    const encoded = btoa(unescape(encodeURIComponent(content)));
    const body    = { message, content: encoded, branch, ...(sha ? { sha } : {}) };

    const res = await ghFetch(`/contents/${filePath}`, {
      method: 'PUT',
      body:   JSON.stringify(body),
    }, token, repo);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || `GitHub push failed: HTTP ${res.status}`);
    }
    return await res.json();
  }

  /* ── Pull file content from GitHub ──────────────────────── */
  async function pullFile(filePath, token, repo, branch) {
    const res = await ghFetch(
      `/contents/${filePath}?ref=${encodeURIComponent(branch)}`,
      {}, token, repo
    );
    if (!res.ok) throw new Error(`File not found: ${filePath}`);
    const data    = await res.json();
    const decoded = decodeURIComponent(escape(atob(data.content.replace(/\s/g, ''))));
    return { content: decoded, sha: data.sha };
  }

  /* ── List backup files in the backup directory ───────────── */
  async function listBackups(token, repo, branch) {
    const res = await ghFetch(
      `/contents/${BACKUP_DIR}?ref=${encodeURIComponent(branch)}`,
      {}, token, repo
    );
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`Could not list backups: HTTP ${res.status}`);
    const files = await res.json();
    return files
      .filter(f => f.name.endsWith('.json'))
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  /* ── Create a full snapshot of all app data ──────────────── */
  async function createSnapshot(encKey, uploadedBy) {
    const snapshot = await Database.exportAll();
    const blobStr  = Encryption.encryptToBlob(snapshot, encKey);
    return {
      blobStr,
      meta: {
        ts:          new Date().toISOString(),
        uploadedBy,
        storeCount:  Object.keys(snapshot).length,
        recordCounts: Object.fromEntries(
          Object.entries(snapshot).map(([k, v]) => [k, v.length])
        ),
      },
    };
  }

  /* ── Push backup to GitHub ───────────────────────────────── */
  async function pushBackup(uploadedBy, onProgress) {
    const cfg = await getConfig();
    if (!cfg.token) throw new Error('GitHub token not configured.');
    if (!cfg.repo)  throw new Error('GitHub repository not configured.');
    if (!cfg.encKey || cfg.encKey.length < 16) throw new Error('Backup encryption key is too short (min 16 chars).');

    if (onProgress) onProgress(10, 'Creating snapshot…');

    const { blobStr, meta } = await createSnapshot(cfg.encKey, uploadedBy);

    const ts       = meta.ts.replace(/[:.]/g, '-').slice(0, 19);
    const fileName = `backup_${ts}.json`;
    const filePath = `${BACKUP_DIR}/${fileName}`;

    if (onProgress) onProgress(40, 'Pushing to GitHub…');

    const counts = Object.entries(meta.recordCounts).map(([k,v]) => `${k}:${v}`).join(', ');
    const commitMsg = `Backup ${ts} by ${uploadedBy} — ${counts}`;

    await pushFile(filePath, blobStr, commitMsg, cfg.token, cfg.repo, cfg.branch);

    // Also update latest.json
    if (onProgress) onProgress(80, 'Updating latest pointer…');
    const latestMeta = JSON.stringify({ ...meta, fileName, filePath }, null, 2);
    await pushFile(`${BACKUP_DIR}/latest.json`, latestMeta, `Update latest pointer — ${ts}`, cfg.token, cfg.repo, cfg.branch);

    if (onProgress) onProgress(100, 'Done');

    await Audit.log({
      module: 'Backup',
      action: 'PushBackup',
      status: 'success',
      detail: `${fileName} — ${counts}`,
    });

    return { fileName, filePath, meta };
  }

  /* ── Fetch list of available backups ─────────────────────── */
  async function fetchBackupList() {
    const cfg = await getConfig();
    if (!cfg.token || !cfg.repo) throw new Error('GitHub not configured.');
    const files = await listBackups(cfg.token, cfg.repo, cfg.branch);
    return files.map(f => ({
      name:    f.name,
      path:    f.path,
      sha:     f.sha,
      size:    f.size,
      htmlUrl: f.html_url,
    }));
  }

  /* ── Restore from a specific backup file ─────────────────── */
  async function restoreBackup(filePath, encKey, onProgress) {
    const cfg = await getConfig();
    if (!cfg.token || !cfg.repo) throw new Error('GitHub not configured.');
    const key = encKey || cfg.encKey;
    if (!key) throw new Error('Encryption key required to decrypt backup.');

    if (onProgress) onProgress(20, 'Downloading backup…');
    const { content } = await pullFile(filePath, cfg.token, cfg.repo, cfg.branch);

    if (onProgress) onProgress(60, 'Decrypting…');
    const { data, metadata } = Encryption.decryptFromBlob(content, key);

    if (onProgress) onProgress(80, 'Restoring to IndexedDB…');
    await Database.importAll(data);

    if (onProgress) onProgress(100, 'Done');

    await Audit.log({
      module: 'Backup',
      action: 'RestoreBackup',
      status: 'success',
      detail: `Restored from ${filePath} (ts: ${metadata.ts})`,
    });

    return { metadata, storeCount: Object.keys(data).length };
  }

  return {
    testConnection,
    pushBackup,
    fetchBackupList,
    restoreBackup,
    getConfig,
  };
})();
