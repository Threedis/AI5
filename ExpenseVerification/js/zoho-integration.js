/**
 * zoho-integration.js — Direct Zoho Projects client using OAuth implicit flow.
 *
 * No proxy server required. The browser authenticates with Zoho via OAuth 2.0
 * implicit grant (response_type=token) and calls the Zoho Projects REST API
 * directly. The access token is stored in sessionStorage.
 *
 * Prerequisites (one-time setup by admin):
 *   1. Create a Zoho API Console app at https://api-console.zoho.com/
 *      - Client type: "JavaScript Client"
 *      - Authorised redirect URI: this page's URL
 *        (e.g. https://threedis.github.io/RCMS/ExpenseVerification/user.html)
 *   2. Enter the Client ID in the settings panel in the app.
 *      (Client Secret is NOT required for implicit flow.)
 *
 * Token lifecycle:
 *   - Stored in sessionStorage; clears on tab/browser close.
 *   - Zoho implicit tokens expire in 1 hour; the UI prompts reconnect on expiry.
 */

const ZohoProjects = (() => {

  const API_BASE      = 'https://expense.threed.workers.dev/restapi';
  const ACCOUNTS_URL  = 'https://accounts.zoho.com/oauth/v2/auth';
  const PORTAL_NAME   = 'hbegroupprojects';
  const SCOPE         = 'ZohoProjects.portals.READ,ZohoProjects.tasks.READ,' +
                        'ZohoProjects.tasklists.READ,ZohoProjects.projects.READ,' +
                        'ZohoProjects.comments.READ';
  const TOKEN_KEY     = 'zoho_token';

  /* ── Client ID — set once by admin (Admin → Settings), shared by everyone ── */
  async function getClientId() { return Database.getSetting('zohoClientId', ''); }

  /* ── Token management ────────────────────────────────────── */
  function getToken() {
    try {
      const raw = sessionStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (Date.now() >= d.expiresAt) { sessionStorage.removeItem(TOKEN_KEY); return null; }
      return d.token;
    } catch { return null; }
  }

  function storeToken(token, expiresIn) {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
      token,
      expiresAt: Date.now() + (parseInt(expiresIn, 10) - 60) * 1000,
    }));
  }

  function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }

  function isConnected() { return !!getToken(); }

  /* ── OAuth callback — call on page load ──────────────────── */
  function handleOAuthCallback() {
    if (!location.hash) return false;
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token     = params.get('access_token');
    const expiresIn = params.get('expires_in') || '3600';
    if (!token) return false;
    storeToken(token, expiresIn);
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  }

  /* ── Initiate OAuth redirect ─────────────────────────────── */
  async function connect() {
    const clientId = await getClientId();
    if (!clientId) throw new Error('Zoho Client ID is not configured. Ask an admin to set it in Admin → Settings.');
    const redirectUri = location.href.split('#')[0].split('?')[0];
    const params = new URLSearchParams({
      response_type: 'token',
      client_id:     clientId,
      scope:         SCOPE,
      redirect_uri:  redirectUri,
      prompt:        'consent',
      access_type:   'online',
    });
    location.href = `${ACCOUNTS_URL}?${params}`;
  }

  function disconnect() { clearToken(); }

  /* ── Zoho Projects REST API call ─────────────────────────── */
  async function apiGet(path) {
    const token = getToken();
    if (!token) throw new Error('Not connected. Click "Connect to Zoho" to authenticate.');
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Authorization': `Zoho-oauthtoken ${token}` },
    });
    if (res.status === 401) {
      clearToken();
      throw new Error('Zoho session expired. Click "Connect to Zoho" to reconnect.');
    }
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const msg = json.error?.message || json.message || `Zoho API error ${res.status}`;
      console.debug(`[Zoho] ${res.status} on ${path}:`, json);
      throw new Error(msg);
    }
    return json;
  }

  /* ── Approval status derivation ──────────────────────────── */
  function deriveApprovalStatus(task) {
    const s = (task.status?.name || task.status || '').toLowerCase();
    if (/complet|done|approv|clear|paid/i.test(s))   return 'approved';
    if (/reject|denied|cancel|revert/i.test(s))      return 'rejected';
    if (/pending|progress|review|open|new/i.test(s)) return 'pending';
    return 'unknown';
  }

  /* ── Extract approvers from task object ──────────────────── */
  function extractApprovers(task) {
    const names = new Set();
    (task.details?.owners || []).forEach(o => { if (o.display_name) names.add(o.display_name); });
    if (task.modified_by?.display_name) names.add(task.modified_by.display_name);
    (task.custom_fields || []).forEach(cf => {
      if (/approv|authoris|authoriz/i.test(cf.column_name || cf.label_name || '')) {
        if (cf.value) names.add(String(cf.value).trim());
      }
    });
    return [...names];
  }

  /* ── Extract employee name from task text ────────────────── */
  function extractEmpName(task) {
    const text = [task.name || '', task.description || ''].join('\n');
    const m = text.match(/(?:emp(?:loyee)?\s*name|name)\s*[:\-]\s*([A-Za-z][A-Za-z\s]{2,40})/i);
    return m ? m[1].trim() : '';
  }

  /* ── Extract amount from task text / custom fields ───────── */
  function extractAmount(task) {
    // Check custom fields first
    for (const cf of (task.custom_fields || [])) {
      const label = (cf.column_name || cf.label_name || '').toLowerCase();
      if (/amount|net\s*pay|salary|total/i.test(label) && cf.value) {
        const n = parseFloat(String(cf.value).replace(/[^0-9.]/g, ''));
        if (!isNaN(n) && n > 0) return n;
      }
    }
    // Parse from description / task name
    const text = [task.name || '', task.description || ''].join('\n');
    const m = text.match(/(?:amount|net\s*pay|salary|total)\s*[:\-\s]?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (m) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!isNaN(n) && n > 0) return n;
    }
    return 0;
  }

  /* ── Extract employee IDs from task text ─────────────────── */
  function extractEmpIds(task) {
    const text = [
      task.name || '',
      task.description || '',
      ...(task.custom_fields || []).map(cf => String(cf.value || '')),
    ].join(' ');

    const ids = new Set();

    // Context-aware: "Emp ID- RHQ-047", "Employee No: 1234", "Emp Code - ABC01"
    for (const m of text.matchAll(/emp(?:loyee)?\s*(?:id|no|code)[.\-:\s]+([A-Z0-9][A-Z0-9\-\/]{2,15})/gi)) {
      ids.add(m[1].trim().toUpperCase());
    }

    const patterns = [
      /\bEMP[-_/]?\d{3,8}\b/gi,
      /\bE[-_]?\d{4,8}\b/gi,
      /\bSTAFF[-_]?\d{3,8}\b/gi,
      /\bP[-_]?\d{4,8}\b/gi,
      /\b\d{4,8}\/\d{2,4}\b/g,
    ];
    for (const pat of patterns) {
      for (const m of text.matchAll(new RegExp(pat.source, pat.flags))) ids.add(m[0].toUpperCase());
    }
    return [...ids];
  }

  /* ── Extract emp IDs / name / amount from comment text ───── */
  function extractFromComments(comments) {
    const ids = new Set();
    let empName = '';
    let amount  = 0;

    for (const c of comments) {
      const text = c.content || '';

      // Context-aware: "Emp ID- RHQ-047", "Employee No: EMP001"
      for (const m of text.matchAll(/emp(?:loyee)?\s*(?:id|no|code)[.\-:\s]+([A-Z0-9][A-Z0-9\-\/]{2,15})/gi)) {
        ids.add(m[1].trim().toUpperCase());
      }

      // Generic "LETTERS-digits" format (e.g. RHQ-047) only when "emp" is nearby
      for (const m of text.matchAll(/\b([A-Z]{2,6}-\d{2,6})\b/gi)) {
        const before = text.slice(Math.max(0, m.index - 30), m.index).toLowerCase();
        if (/emp/i.test(before)) ids.add(m[1].toUpperCase());
      }

      // Employee name: "Emp Name- Ramniwash ..."
      if (!empName) {
        const nm = text.match(/emp(?:loyee)?\s*name[.\-:\s]+([A-Za-z][A-Za-z\s]{1,40}?)(?:\s{2,}|[-–]\s*\d|\s+(?:tour|advance|salary|pay)\b|$)/i);
        if (nm) empName = nm[1].trim();
      }

      // Amount: look for leading "-15000" or "Amount: 15000" or plain number after context
      const amtPatterns = [
        /(?:amount|advance|pay|salary|total)[.\-:\s]+(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/gi,
        /[-–]\s*([\d,]{4,}(?:\.\d{1,2})?)\b/g,
      ];
      for (const pat of amtPatterns) {
        for (const m of text.matchAll(pat)) {
          const n = parseFloat(m[1].replace(/,/g, ''));
          if (!isNaN(n) && n > amount) amount = n;
        }
      }
    }

    return { ids: [...ids], empName, amount };
  }

  /* ── Parse a raw Zoho task object into our approval shape ── */
  function parseTask(raw, taskId) {
    const task = Array.isArray(raw.tasks) ? raw.tasks[0] : (raw.task || raw);
    if (!task || (!task.id && !task.id_string)) throw new Error(`Task ${taskId} not found in Zoho Projects.`);

    const empIds    = extractEmpIds(task);
    const approvers = extractApprovers(task);
    const summaryProvider = task.created_by?.display_name || task.created_by || '';
    const taskAmount  = extractAmount(task);
    const taskEmpName = extractEmpName(task);
    // Build a per-empId amount map (same amount for all IDs if only one amount found)
    const zohoAmounts = {};
    if (taskAmount > 0) empIds.forEach(id => { zohoAmounts[id.toUpperCase()] = taskAmount; });

    const customMap = {};
    (task.custom_fields || []).forEach(cf => {
      const label = cf.column_name || cf.label_name || cf.field_id || '';
      if (label && cf.value != null) customMap[label] = String(cf.value);
    });

    return {
      taskId:         task.id_string || task.id || taskId,
      taskName:       task.name || '',
      projectName:    task.project?.name || '',
      projectId:      task.project?.id_string || task.project?.id || '',
      status:         task.status?.name || task.status || '',
      approvalStatus: deriveApprovalStatus(task),
      createdBy:      summaryProvider,
      summaryProvider,
      approvers,
      empIds,
      zohoAmounts,
      zohoEmpName:    taskEmpName,
      assignees:      (task.details?.owners || []).map(o => o.display_name || '').filter(Boolean),
      description:    task.description || '',
      createdAt:      task.created_time_string || task.created_time || '',
      dueDate:        task.end_date_string || task.end_date || '',
      isCompleted:    !!task.completed,
      customFields:   customMap,
      _raw:           task,
    };
  }

  /* ── Fetch tasks from one tasklist, trying several param combos */
  async function fetchTasklistTasks(projectId, tlId) {
    const base = `/portal/${enc(PORTAL_NAME)}/projects/${enc(projectId)}/tasklists/${enc(tlId)}/tasks/`;
    const attempts = [
      base,                         // no params
      `${base}?type=open_tasks`,
      `${base}?type=closed_tasks`,
      `${base}?status=open`,
      `${base}?status=closed`,
    ];
    for (const url of attempts) {
      try {
        const data = await apiGet(url);
        if (data.tasks) return data.tasks;
      } catch { /* try next variant */ }
    }
    return [];
  }

  /* ── Fetch all tasks for a project via task lists ────────── */
  async function fetchAllTasks(projectId) {
    // Try project-level endpoint first (faster, one call)
    for (const type of ['open_tasks', 'closed_tasks', '']) {
      try {
        const q    = type ? `?type=${type}` : '';
        const data = await apiGet(`/portal/${enc(PORTAL_NAME)}/projects/${enc(projectId)}/tasks/${q}`);
        if (data.tasks && data.tasks.length) {
          console.debug(`[Zoho] project ${projectId} tasks via project endpoint (${type||'bare'}): ${data.tasks.length}`);
          // If open-only, also grab closed
          if (type === 'open_tasks') {
            try {
              const closed = await apiGet(`/portal/${enc(PORTAL_NAME)}/projects/${enc(projectId)}/tasks/?type=closed_tasks`);
              return [...data.tasks, ...(closed.tasks || [])];
            } catch { return data.tasks; }
          }
          return data.tasks;
        }
      } catch { /* try next */ }
    }

    // Fall back: iterate task lists
    const listData = await apiGet(`/portal/${enc(PORTAL_NAME)}/projects/${enc(projectId)}/tasklists/`);
    const tasklists = listData.tasklists || [];
    const all = [];
    for (const tl of tasklists) {
      const tasks = await fetchTasklistTasks(projectId, tl.id_string || tl.id);
      all.push(...tasks);
    }
    return all;
  }

  /* ── Normalize O↔0 so "S07-T1" matches "SO7-T1" ─────────── */
  function normalizeOZ(s) { return s.replace(/[O0]/g, 'X'); }

  /* ── Match a task list against a display ID ─────────────── */
  function matchTask(tasks, upper, projPrefix) {
    const upperNorm = normalizeOZ(upper);
    return tasks.find(t => {
      const key     = (t.key      || '').toUpperCase();
      const taskKey = (t.task_key || '').toUpperCase();
      if (key === upper || taskKey === upper) return true;
      if (normalizeOZ(key) === upperNorm || normalizeOZ(taskKey) === upperNorm) return true;

      // Zoho sometimes omits the "T": e.g. "SO7-1" instead of "SO7-T1"
      const seq = String(t.sequence_num || t.task_index || '');
      if (seq) {
        if (projPrefix && normalizeOZ(`${projPrefix}-T${seq}`) === upperNorm) return true;
        if (projPrefix && normalizeOZ(`${projPrefix}-${seq}`)  === upperNorm) return true;
      }
      return false;
    });
  }

  /* ── Resolve display ID in parallel across all projects ──── */
  async function resolveDisplayId(displayId) {
    const upper = displayId.toUpperCase();

    const projData = await apiGet(`/portal/${enc(PORTAL_NAME)}/projects/`);
    const projects  = projData.projects || [];
    console.debug(`[Zoho] Searching ${projects.length} projects (parallel) for "${displayId}"`);

    // Try projects in parallel batches of 6 to avoid rate-limiting
    const BATCH = 6;
    for (let i = 0; i < projects.length; i += BATCH) {
      const batch = projects.slice(i, i + BATCH);

      // Race all projects in the batch; first match wins
      const result = await Promise.any(
        batch.map(async project => {
          const projectId  = project.id_string || project.id;
          const projPrefix = (project.prefix || project.key || project.name || '').toUpperCase();
          const tasks = await fetchAllTasks(projectId);
          const match = matchTask(tasks, upper, projPrefix);
          if (!match) throw new Error('not found');
          if (!match.project) match.project = { id_string: projectId, name: project.name };
          return { task: match, projectId };
        })
      ).catch(() => null); // entire batch missed — move to next batch

      if (result) return result;
    }

    throw new Error(`Task "${displayId}" not found. Checked ${projects.length} project(s).`);
  }

  /* ── Fetch task via direct API ───────────────────────────── */
  async function fetchTask(taskId) {
    const input = taskId.trim();

    let parsed;

    // Display ID path: e.g. "S07-T1" or "SO7-T1"
    if (/^[A-Za-z0-9]+-[Tt]\d+$/.test(input)) {
      const resolved = await resolveDisplayId(input);
      if (resolved) {
        const { task, projectId } = resolved;
        if (!task.project) task.project = { id_string: projectId };
        parsed = parseTask({ tasks: [task] }, input);
      }
    }

    if (!parsed) {
      // Fallback: search by term (works for numeric IDs or task names)
      const data = await apiGet(`/portal/${enc(PORTAL_NAME)}/tasks/?search_term=${enc(input)}`);
      parsed = parseTask(data, input);
    }

    // Enrich with comments and attachments in parallel
    const [comments, attachments] = await Promise.all([
      fetchTaskComments(parsed.taskId, parsed.projectId),
      fetchTaskAttachments(parsed.taskId, parsed.projectId),
    ]);

    parsed.comments    = comments;
    parsed.attachments = attachments.map(a => ({ ...a, kind: classifyAttachment(a) }));

    // Merge emp IDs, name, and amounts found in comments
    const commentData = extractFromComments(comments);
    for (const id of commentData.ids) {
      if (!parsed.empIds.includes(id)) parsed.empIds.push(id);
    }
    if (!parsed.zohoEmpName && commentData.empName) parsed.zohoEmpName = commentData.empName;
    if (commentData.amount > 0) {
      parsed.empIds.forEach(id => {
        if (!parsed.zohoAmounts[id.toUpperCase()]) parsed.zohoAmounts[id.toUpperCase()] = commentData.amount;
      });
    }

    // If task status alone is not conclusive, check comments for approval signals
    const commentApproval = deriveCommentApproval(comments);
    if (commentApproval.status && parsed.approvalStatus !== 'approved' && parsed.approvalStatus !== 'rejected') {
      parsed.approvalStatus = commentApproval.status;
    }
    const allApprovers = new Set([...parsed.approvers, ...commentApproval.approvers]);
    parsed.approvers   = [...allApprovers];

    // Track which sources contributed evidence
    const evidenceSources = [];
    if (parsed.status) evidenceSources.push('task-status');
    if (comments.length) evidenceSources.push('comments');
    const imageEvidence = parsed.attachments.filter(a => ['whatsapp','screenshot','email','approval-doc','image'].includes(a.kind));
    if (imageEvidence.length) evidenceSources.push('attachments');
    parsed.evidenceSources = evidenceSources;

    return parsed;
  }

  /* ── Sanitize Zoho's rich-text comment HTML for safe display ──
     Keeps formatting tags (bold/italic/lists/line breaks) and safe
     links; drops everything else but preserves its text content.
     [@zpuser#id#Name] mentions are dropped entirely (Zoho re-shows
     the author's name in the comment header already — keeping the
     mention inline would just duplicate it). ── */
  const MENTION_RE   = /\[?@zpuser#\d+#[^\]]*\]?\s*/g;
  const ALLOWED_TAGS = new Set(['B','STRONG','I','EM','U','BR','P','DIV','SPAN','UL','OL','LI','A']);
  const VOID_TAGS    = new Set(['BR']);

  function renderMentionText(text) {
    return Utils.escapeHtml(text.replace(MENTION_RE, ''));
  }

  function sanitizeNode(node) {
    if (node.nodeType === Node.TEXT_NODE) return renderMentionText(node.nodeValue || '');
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') return '';
    const inner = Array.from(node.childNodes).map(sanitizeNode).join('');
    if (!ALLOWED_TAGS.has(tag)) return inner;
    if (VOID_TAGS.has(tag)) return '<br>';
    if (tag === 'A') {
      const href = node.getAttribute('href') || '';
      const safe = /^(https?:|mailto:)/i.test(href) ? href : '';
      return safe
        ? `<a href="${Utils.escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${inner}</a>`
        : inner;
    }
    return `<${tag.toLowerCase()}>${inner}</${tag.toLowerCase()}>`;
  }

  function sanitizeCommentHtml(raw) {
    if (!raw) return '';
    const doc = new DOMParser().parseFromString(String(raw), 'text/html');
    return Array.from(doc.body.childNodes).map(sanitizeNode).join('');
  }

  /* ── Zoho wraps some internal identifiers as "zp<value>zp" — unwrap them.
     e.g. the raw name field can literally be "zpAjay Kumarzp". ── */
  function stripZpWrap(s) {
    const m = String(s || '').trim().match(/^zp(.+?)zp$/i);
    return (m ? m[1] : String(s || '')).trim();
  }

  function cleanAuthorName(raw) {
    let s = stripZpWrap(raw);
    s = s.replace(/\[?@zpuser#\d+#([^\]]*)\]?/gi, '$1').trim();
    return s && isNaN(s) ? s : '';
  }

  /* ── Resolve a comment's author from whichever field Zoho populated ── */
  function resolveCommentAuthor(c) {
    const candidates = [c.created_by, c.added_by, c.author, c.user];
    for (const cand of candidates) {
      if (!cand) continue;
      if (typeof cand === 'string') {
        const name = cleanAuthorName(cand);
        if (name) return { name, photo: '', id: '' };
        continue;
      }
      const name = cleanAuthorName(cand.name) || cleanAuthorName(cand.display_name) ||
                   cleanAuthorName(cand.full_name) ||
                   (cand.email ? String(cand.email).split('@')[0] : '');
      if (name) return { name, photo: cand.photo || cand.photo_url || cand.image || '', id: cand.id || cand.zpuid || '' };
    }
    return { name: '', photo: '', id: '' };
  }

  /* ── Fetch comments via direct API ──────────────────────── */
  async function fetchTaskComments(taskId, projectId) {
    if (!projectId) return [];
    try {
      const data = await apiGet(`/portal/${enc(PORTAL_NAME)}/projects/${enc(projectId)}/tasks/${enc(taskId)}/comments/`);
      return (data.comments || []).map(c => {
        const raw = c.comment ?? c.content ?? '';
        // Plain-text version (for regex-based extraction elsewhere) — mentions fully stripped
        const plain = Utils.stripHtml(raw);
        const cleanContent = plain.trim().replace(/\[?@zpuser#\d+#[^\]]*\]?/g, '').trim();
        const { name: authorName, photo: authorPhoto, id: authorId } = resolveCommentAuthor(c);
        const rawAtts = c.attachments || c.documents || c.files || [];
        const attachments = rawAtts.map(a => ({
          name:    a.filename || a.file_name || a.name || a.title || 'Attachment',
          size:    a.filesize || a.file_size || a.size || 0,
          url:     a.download_url || a.url || a.file_url || a.link || a.href || '',
          isImage: /\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(a.filename || a.file_name || a.name || a.title || ''),
        }));
        return {
          author:      authorName,
          authorPhoto,
          authorId,
          content:     cleanContent,
          contentHtml: sanitizeCommentHtml(raw),
          attachments,
          isEdited:    !!(c.edited ?? c.is_edited ?? c.edited_time_long ?? c.edited_time_string),
          createdAt:   c.created_time || c.time_long || c.added_time_string || '',
        };
      });
    } catch { return []; }
  }

  /* ── Fetch task attachments (file names only) ────────────── */
  async function fetchTaskAttachments(taskId, projectId) {
    if (!projectId) return [];
    try {
      const data = await apiGet(`/portal/${enc(PORTAL_NAME)}/projects/${enc(projectId)}/tasks/${enc(taskId)}/attachments/`);
      return (data.attachments || []).map(a => ({
        name:      a.filename || a.file_name || a.name || '',
        size:      a.filesize || a.file_size || 0,
        createdAt: a.created_time_string || '',
        url:       a.download_url || a.url || '',
        isImage:   /\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(a.filename || a.file_name || ''),
      }));
    } catch { return []; }
  }

  /* ── Derive approval from comment text ───────────────────── */
  const APPROVAL_POSITIVE = /\bapprov(ed|al|e)\b|\bsanction(ed)?\b|\bauthori[sz]ed?\b|\bcleared?\b|\bok(?:ay)?\b|\bverified?\b|\baccept(ed)?\b|\bpaid\b/i;
  const APPROVAL_NEGATIVE = /\breject(ed)?\b|\bdenied?\b|\bdeclined?\b|\bcancell?ed?\b|\bdo\s+not\s+approv/i;

  function deriveCommentApproval(comments) {
    let status   = null;
    const names  = new Set();
    for (const c of comments) {
      const txt = c.content || '';
      if (APPROVAL_NEGATIVE.test(txt)) { status = 'rejected'; if (c.author) names.add(c.author); break; }
      if (APPROVAL_POSITIVE.test(txt)) { status = 'approved'; if (c.author) names.add(c.author); }
    }
    return { status, approvers: [...names] };
  }

  /* ── Classify attachments as approval evidence ───────────── */
  function classifyAttachment(att) {
    const n = (att.name || '').toLowerCase();
    if (/whatsapp/i.test(n))                              return 'whatsapp';
    if (/screenshot|screen.?shot|screen.?grab/i.test(n)) return 'screenshot';
    if (/mail|email|outlook|gmail/i.test(n))              return 'email';
    if (/approval|approved|sanction/i.test(n))            return 'approval-doc';
    if (att.isImage)                                      return 'image';
    return 'other';
  }

  const enc = encodeURIComponent;

  /* ── Human-readable summary ──────────────────────────────── */
  function getSummary(parsed) {
    const parts = [];
    if (parsed.approvalStatus !== 'unknown') parts.push(`Status: ${Utils.titleCase(parsed.approvalStatus)}`);
    if (parsed.taskName)         parts.push(`Task: ${parsed.taskName}`);
    if (parsed.projectName)      parts.push(`Project: ${parsed.projectName}`);
    if (parsed.summaryProvider)  parts.push(`Submitted by: ${parsed.summaryProvider}`);
    if (parsed.approvers.length) parts.push(`Approver: ${parsed.approvers[0]}`);
    if (parsed.empIds.length)    parts.push(`${parsed.empIds.length} emp ID(s) found`);
    return parts.join(' · ') || 'Task fetched — no structured data detected';
  }

  return {
    handleOAuthCallback,
    connect,
    disconnect,
    isConnected,
    getClientId,
    fetchTask,
    fetchTaskComments,
    fetchTaskAttachments,
    getSummary,
    parseTask,
    deriveCommentApproval,
    classifyAttachment,
  };

})();
