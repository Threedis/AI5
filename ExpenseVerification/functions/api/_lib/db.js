/**
 * db.js — D1 query helpers, mirroring the old database.js/Supabase call shapes.
 */

// store name (as used by the frontend's Database.TABLE map) -> SQL table
export const TABLE = {
  users:           'profiles',
  hrMaster:        'hr_master',
  accountsMaster:  'accounts_master',
  auditLogs:       'audit_logs',
  settings:        'settings',
  versionHistory:  'version_history',
  verifications:   'verifications',
  accountsBatches: 'accounts_batches',
};

// explicit column allowlists — insert/upsert only ever writes columns listed
// here, so a record object can't smuggle arbitrary column names into SQL.
const COLUMNS = {
  profiles: ['id', 'username', 'password_hash', 'password_salt', 'display_name', 'email', 'role', 'department', 'status', 'created_at'],
  hr_master: ['id', 'employee_id', 'employee_name', 'month', 'year', 'branch', 'division', 'bank_name', 'bank_account_number', 'ifsc', 'name_in_bank', 'batch_id', 'version', 'created_at'],
  accounts_master: ['id', 'emp_code', 'emp_name', 'bank_name', 'account_no', 'ifsc', 'net_pay', 'section', 'name_in_bank', 'batch_id', 'sheet', 'created_at'],
  audit_logs: ['id', 'user_id', 'username', 'module', 'action', 'status', 'detail', 'ip', 'created_at'],
  settings: ['key', 'value', 'updated_at'],
  verifications: ['id', 'created_by', 'source', 'pdf_file', 'summary', 'results', 'created_at'],
  version_history: ['id', 'type', 'version', 'detail', 'created_at'],
  accounts_batches: ['id', 'batch_no', 'is_active', 'detail', 'created_at'],
};

// the generic /api/data/profiles endpoint never returns credential columns
const SAFE_COLUMNS = {
  profiles: COLUMNS.profiles.filter(c => c !== 'password_hash' && c !== 'password_salt'),
};

// columns stored as JSON-stringified TEXT (SQLite has no jsonb)
const JSON_COLUMNS = {
  settings: ['value'],
  verifications: ['summary', 'results'],
  version_history: ['detail'],
  accounts_batches: ['detail'],
};

// primary-key column per table (everything is 'id' except settings, keyed by 'key')
const PK_COLUMN = { settings: 'key' };

export function tbl(store) {
  const t = TABLE[store];
  if (!t) throw new Error(`Unknown store: ${store}`);
  return t;
}

export function pkColumn(table) {
  return PK_COLUMN[table] || 'id';
}

function decodeRow(table, row) {
  if (!row) return row;
  const jsonCols = JSON_COLUMNS[table];
  if (!jsonCols) return row;
  const out = { ...row };
  for (const col of jsonCols) {
    if (out[col] != null) {
      try { out[col] = JSON.parse(out[col]); } catch { /* leave as-is */ }
    }
  }
  return out;
}

function encodeRecord(table, record) {
  const jsonCols = JSON_COLUMNS[table] || [];
  const out = { ...record };
  for (const col of jsonCols) {
    if (out[col] != null && typeof out[col] !== 'string') out[col] = JSON.stringify(out[col]);
  }
  return out;
}

function allowedColumns(table, { safe = false } = {}) {
  const cols = (safe && SAFE_COLUMNS[table]) ? SAFE_COLUMNS[table] : COLUMNS[table];
  if (!cols) throw new Error(`No column list for table: ${table}`);
  return cols;
}

export async function selectAll(env, table, { safe = false } = {}) {
  const cols = allowedColumns(table, { safe });
  const { results } = await env.DB.prepare(`select ${cols.join(',')} from ${table}`).all();
  return (results || []).map(r => decodeRow(table, r));
}

export async function selectOne(env, table, id, { safe = false } = {}) {
  const cols = allowedColumns(table, { safe });
  const pk = pkColumn(table);
  const row = await env.DB.prepare(`select ${cols.join(',')} from ${table} where ${pk} = ?`).bind(id).first();
  return decodeRow(table, row);
}

export async function selectByIndex(env, table, indexName, value, { safe = false } = {}) {
  const cols = allowedColumns(table, { safe });
  if (!COLUMNS[table]?.includes(indexName)) throw new Error(`Unknown column: ${indexName}`);
  const { results } = await env.DB.prepare(`select ${cols.join(',')} from ${table} where ${indexName} = ?`).bind(value).all();
  return (results || []).map(r => decodeRow(table, r));
}

function withGeneratedPk(table, encoded) {
  const pk = pkColumn(table);
  if (pk === 'id' && !encoded.id) return { ...encoded, id: crypto.randomUUID() };
  return encoded;
}

export async function insertRow(env, table, record) {
  const encoded = withGeneratedPk(table, encodeRecord(table, record));
  const cols = COLUMNS[table].filter(c => encoded[c] !== undefined);
  const placeholders = cols.map(() => '?').join(',');
  await env.DB.prepare(`insert into ${table} (${cols.join(',')}) values (${placeholders})`)
    .bind(...cols.map(c => encoded[c])).run();
  return selectOne(env, table, encoded[pkColumn(table)]);
}

export async function upsertRow(env, table, record) {
  const encoded = withGeneratedPk(table, encodeRecord(table, record));
  const pk = pkColumn(table);
  const cols = COLUMNS[table].filter(c => encoded[c] !== undefined);
  const placeholders = cols.map(() => '?').join(',');
  const updates = cols.filter(c => c !== pk).map(c => `${c} = excluded.${c}`).join(',');
  await env.DB.prepare(
    `insert into ${table} (${cols.join(',')}) values (${placeholders})
     on conflict(${pk}) do update set ${updates}`
  ).bind(...cols.map(c => encoded[c])).run();
  return selectOne(env, table, encoded[pk]);
}

export async function bulkUpsert(env, table, records) {
  for (const record of records) await upsertRow(env, table, record);
  return records.length;
}

export async function deleteRow(env, table, id) {
  const pk = pkColumn(table);
  await env.DB.prepare(`delete from ${table} where ${pk} = ?`).bind(id).run();
}

export async function deleteAll(env, table) {
  await env.DB.prepare(`delete from ${table}`).run();
}

export async function countRows(env, table) {
  const row = await env.DB.prepare(`select count(*) as c from ${table}`).first();
  return row?.c || 0;
}
