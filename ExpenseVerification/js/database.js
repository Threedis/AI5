/**
 * database.js — IndexedDB wrapper for all application data
 * Employee Expense Verification System
 */

const Database = (() => {

  const DB_NAME    = 'ExpenseVerificationDB';
  const DB_VERSION = 1;
  let   _db        = null;

  /* ── Store definitions ──────────────────────────────────── */
  const STORES = {
    users:          { keyPath: 'id', indexes: [{ name: 'username', unique: true }] },
    hrMaster:       { keyPath: 'id', indexes: [
                       { name: 'employeeId', unique: false },
                       { name: 'version',    unique: false }
                     ]},
    accountsMaster: { keyPath: 'id', indexes: [
                       { name: 'empCode',  unique: false },
                       { name: 'batchId',  unique: false }
                     ]},
    auditLogs:      { keyPath: 'id', indexes: [
                       { name: 'user',   unique: false },
                       { name: 'module', unique: false },
                       { name: 'date',   unique: false }
                     ]},
    settings:       { keyPath: 'key' },
    versionHistory: { keyPath: 'id', indexes: [
                       { name: 'type',    unique: false },
                       { name: 'version', unique: false }
                     ]},
    verifications:  { keyPath: 'id', indexes: [
                       { name: 'batchId', unique: false },
                       { name: 'status',  unique: false }
                     ]}
  };

  /* ── Open database ──────────────────────────────────────── */
  function open() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = e => {
        const db = e.target.result;
        for (const [name, config] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(name)) {
            const store = db.createObjectStore(name, { keyPath: config.keyPath });
            (config.indexes || []).forEach(idx => {
              store.createIndex(idx.name, idx.name, { unique: !!idx.unique });
            });
          }
        }
      };

      req.onsuccess = e => { _db = e.target.result; resolve(_db); };
      req.onerror   = e => reject(e.target.error);
    });
  }

  /* ── Generic transaction helper ─────────────────────────── */
  async function tx(storeName, mode, fn) {
    const db   = await open();
    return new Promise((resolve, reject) => {
      const trans = db.transaction(storeName, mode);
      const store = trans.objectStore(storeName);
      const req   = fn(store);
      if (req) {
        req.onsuccess = e => resolve(e.target.result);
        req.onerror   = e => reject(e.target.error);
      } else {
        trans.oncomplete = () => resolve();
        trans.onerror    = e  => reject(e.target.error);
      }
    });
  }

  /* ── CRUD ───────────────────────────────────────────────── */
  async function add(store, record) {
    return tx(store, 'readwrite', s => s.add(record));
  }

  async function put(store, record) {
    return tx(store, 'readwrite', s => s.put(record));
  }

  async function get(store, key) {
    return tx(store, 'readonly', s => s.get(key));
  }

  async function getAll(store) {
    return tx(store, 'readonly', s => s.getAll());
  }

  async function getByIndex(store, indexName, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const trans = db.transaction(store, 'readonly');
      const idx   = trans.objectStore(store).index(indexName);
      const req   = idx.getAll(value);
      req.onsuccess = e => resolve(e.target.result);
      req.onerror   = e => reject(e.target.error);
    });
  }

  async function remove(store, key) {
    return tx(store, 'readwrite', s => s.delete(key));
  }

  /** Alias for remove */
  const del = remove;

  async function count(store) {
    return tx(store, 'readonly', s => s.count());
  }

  async function clear(store) {
    return tx(store, 'readwrite', s => { s.clear(); return null; });
  }

  /* ── Bulk put (batch write) ─────────────────────────────── */
  async function bulkPut(store, records) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const trans = db.transaction(store, 'readwrite');
      const s     = trans.objectStore(store);
      records.forEach(r => s.put(r));
      trans.oncomplete = () => resolve(records.length);
      trans.onerror    = e  => reject(e.target.error);
    });
  }

  /* ── Settings helpers ───────────────────────────────────── */
  async function getSetting(key, defaultVal = null) {
    const rec = await get('settings', key);
    return rec ? rec.value : defaultVal;
  }

  async function setSetting(key, value) {
    return put('settings', { key, value, updatedAt: new Date().toISOString() });
  }

  /* ── Export all data (for backup) ───────────────────────── */
  async function exportAll() {
    const snapshot = {};
    for (const name of Object.keys(STORES)) {
      snapshot[name] = await getAll(name);
    }
    snapshot._exportedAt = new Date().toISOString();
    return snapshot;
  }

  /* ── Import from backup ─────────────────────────────────── */
  async function importAll(snapshot) {
    for (const [name, records] of Object.entries(snapshot)) {
      if (name.startsWith('_')) continue;
      if (!STORES[name]) continue;
      await clear(name);
      if (Array.isArray(records) && records.length) await bulkPut(name, records);
    }
  }

  return {
    open, add, put, get, getAll, getByIndex,
    remove, delete: del,
    count, clear, bulkPut,
    getSetting, setSetting,
    exportAll, importAll
  };
})();
