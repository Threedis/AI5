/**
 * database.js — Cloudflare D1 (via Pages Functions) backend.
 * All data is stored centrally and shared across all users/devices.
 */

const Database = (() => {

  /* ── Table name map (store name → API/D1 table) ────────── */
  const TABLE = {
    users:           'profiles',
    hrMaster:        'hr_master',
    accountsMaster:  'accounts_master',
    auditLogs:       'audit_logs',
    settings:        'settings',
    versionHistory:  'version_history',
    verifications:   'verifications',
    accountsBatches: 'accounts_batches',
  };

  function tbl(store) {
    if (!TABLE[store]) throw new Error(`Unknown store: ${store}`);
    return store; // the API is keyed by store name, not the raw table name
  }

  async function apiFetch(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
  }

  /* ── Generic helpers ────────────────────────────────────── */
  async function getAll(store) {
    const { data } = await apiFetch(`/api/data/${tbl(store)}`);
    return data || [];
  }

  async function get(store, key) {
    const { data } = await apiFetch(`/api/data/${tbl(store)}/${encodeURIComponent(key)}`);
    return data;
  }

  async function getByIndex(store, indexName, value) {
    const qs = new URLSearchParams({ index: indexName, value }).toString();
    const { data } = await apiFetch(`/api/data/${tbl(store)}?${qs}`);
    return data || [];
  }

  async function add(store, record) {
    const { data } = await apiFetch(`/api/data/${tbl(store)}`, { method: 'POST', body: JSON.stringify(record) });
    return data;
  }

  async function put(store, record) {
    const { data } = await apiFetch(`/api/data/${tbl(store)}`, { method: 'PUT', body: JSON.stringify(record) });
    return data;
  }

  async function remove(store, key) {
    await apiFetch(`/api/data/${tbl(store)}/${encodeURIComponent(key)}`, { method: 'DELETE' });
  }

  const del = remove;

  async function count(store) {
    const { count: c } = await apiFetch(`/api/data/${tbl(store)}/count`);
    return c || 0;
  }

  async function clear(store) {
    await apiFetch(`/api/data/${tbl(store)}`, { method: 'DELETE' });
  }

  async function bulkPut(store, records) {
    if (!records.length) return 0;
    const CHUNK = 500;
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      await apiFetch(`/api/data/${tbl(store)}/bulk`, { method: 'POST', body: JSON.stringify(chunk) });
    }
    return records.length;
  }

  /* ── Settings helpers ───────────────────────────────────── */
  async function getSetting(key, defaultVal = null) {
    try {
      const { value } = await apiFetch(`/api/settings/${encodeURIComponent(key)}`);
      return value ?? defaultVal;
    } catch {
      return defaultVal;
    }
  }

  async function setSetting(key, value) {
    await apiFetch(`/api/settings/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ value }) });
  }

  /* ── Export / Import (backup) ───────────────────────────── */
  async function exportAll() {
    const snapshot = {};
    for (const store of Object.keys(TABLE)) {
      snapshot[store] = await getAll(store);
    }
    snapshot._exportedAt = new Date().toISOString();
    return snapshot;
  }

  async function importAll(snapshot) {
    for (const [store, records] of Object.entries(snapshot)) {
      if (store.startsWith('_') || !TABLE[store]) continue;
      await clear(store);
      if (Array.isArray(records) && records.length) await bulkPut(store, records);
    }
  }

  /* ── open() shim — no-op, no connection needed */
  async function open() { return true; }

  return {
    open, add, put, get, getAll, getByIndex,
    remove, delete: del,
    count, clear, bulkPut,
    getSetting, setSetting,
    exportAll, importAll,
  };
})();
