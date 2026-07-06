/**
 * database.js — Supabase backend replacing IndexedDB
 * All data is now stored centrally and shared across all users/devices.
 */

const Database = (() => {

  /* ── Table name map (store name → Supabase table) ─────── */
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

  function sb() { return getSupabase(); }
  function tbl(store) {
    const t = TABLE[store];
    if (!t) throw new Error(`Unknown store: ${store}`);
    return t;
  }

  /* ── Generic helpers ────────────────────────────────────── */
  async function getAll(store) {
    const { data, error } = await sb().from(tbl(store)).select('*');
    if (error) throw new Error(error.message);
    return data || [];
  }

  async function get(store, key) {
    const { data, error } = await sb().from(tbl(store)).select('*').eq('id', key).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  }

  async function getByIndex(store, indexName, value) {
    const { data, error } = await sb().from(tbl(store)).select('*').eq(indexName, value);
    if (error) throw new Error(error.message);
    return data || [];
  }

  async function add(store, record) {
    const { data, error } = await sb().from(tbl(store)).insert(record).select().single();
    if (error) throw new Error(error.message);
    return data;
  }

  async function put(store, record) {
    // upsert: insert or update based on id
    const { data, error } = await sb().from(tbl(store)).upsert(record).select().single();
    if (error) throw new Error(error.message);
    return data;
  }

  async function remove(store, key) {
    const { error } = await sb().from(tbl(store)).delete().eq('id', key);
    if (error) throw new Error(error.message);
  }

  const del = remove;

  async function count(store) {
    const { count: c, error } = await sb().from(tbl(store)).select('*', { count: 'exact', head: true });
    if (error) throw new Error(error.message);
    return c || 0;
  }

  async function clear(store) {
    // Delete all rows — uses neq on a guaranteed column value to match all
    const { error } = await sb().from(tbl(store)).delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw new Error(error.message);
  }

  async function bulkPut(store, records) {
    if (!records.length) return 0;
    // Supabase upsert in chunks of 500
    const CHUNK = 500;
    for (let i = 0; i < records.length; i += CHUNK) {
      const chunk = records.slice(i, i + CHUNK);
      const { error } = await sb().from(tbl(store)).upsert(chunk);
      if (error) throw new Error(error.message);
    }
    return records.length;
  }

  /* ── Settings helpers ───────────────────────────────────── */
  async function getSetting(key, defaultVal = null) {
    const { data, error } = await sb().from('settings').select('value').eq('key', key).maybeSingle();
    if (error || !data) return defaultVal;
    return data.value;
  }

  async function setSetting(key, value) {
    const { error } = await sb().from('settings').upsert({ key, value, updated_at: new Date().toISOString() });
    if (error) throw new Error(error.message);
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

  /* ── open() shim — no-op for Supabase (no connection needed) */
  async function open() { return true; }

  return {
    open, add, put, get, getAll, getByIndex,
    remove, delete: del,
    count, clear, bulkPut,
    getSetting, setSetting,
    exportAll, importAll,
  };
})();
