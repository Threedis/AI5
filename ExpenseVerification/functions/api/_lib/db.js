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
  expenseFileLog:  'expense_file_log',
};

// explicit column allowlists — insert/upsert only ever writes columns listed
// here, so a record object can't smuggle arbitrary column names into SQL.
// Frontend records use camelCase (employeeId, empCode, ...); columns are
// snake_case — see camelToSnake/snakeToCamel below for the translation.
const COLUMNS = {
  profiles: ['id', 'username', 'password_hash', 'password_salt', 'display_name', 'email', 'role', 'department', 'status', 'created_at'],
  hr_master: ['id', 'employee_id', 'employee_name', 'month', 'year', 'branch', 'division', 'bank_name', 'bank_account_number', 'ifsc', 'name_in_bank', 'batch_id', 'version', 'created_at'],
  accounts_master: ['id', 'emp_code', 'emp_name', 'bank_name', 'account_no', 'ifsc', 'net_pay', 'section', 'name_in_bank', 'batch_id', 'sheet', 'created_at'],
  audit_logs: ['id', 'user_id', 'username', 'module', 'action', 'status', 'detail', 'ip', 'created_at'],
  settings: ['key', 'value', 'updated_at'],
};

// the generic /api/data/profiles endpoint never returns credential columns
const SAFE_COLUMNS = {
  profiles: COLUMNS.profiles.filter(c => c !== 'password_hash' && c !== 'password_salt'),
};

// columns stored as JSON-stringified TEXT (SQLite has no jsonb)
const JSON_COLUMNS = {
  settings: ['value'],
};

// primary-key column per table (everything is 'id' except settings, keyed by 'key')
const PK_COLUMN = { settings: 'key' };

// Tables holding arbitrary, module-defined records (HR version snapshots,
// verification sessions, accounts batches) rather than a fixed business
// schema — these modules encrypt and stash whatever shape of object they
// want (encryptedData, fileNames, validationSummary, ...), so a column
// allowlist would silently drop most of it. Store the whole record as one
// JSON blob instead and hand it back byte-for-byte on read.
const BLOB_TABLES = new Set(['verifications', 'version_history', 'accounts_batches', 'expense_file_log']);

// hr_master/accounts_master records are built by hr.js/accounts.js using
// camelCase field names (employeeId, empCode, ...) — translate to/from the
// snake_case SQL columns. profiles/audit_logs/settings are read as raw
// column names by admin.html (u.display_name) and are left untouched.
const CASE_CONVERT_TABLES = new Set(['hr_master', 'accounts_master']);

export function tbl(store) {
  const t = TABLE[store];
  if (!t) throw new Error(`Unknown store: ${store}`);
  return t;
}

export function pkColumn(table) {
  return PK_COLUMN[table] || 'id';
}

function camelToSnake(key) {
  return key.replace(/([A-Z])/g, '_$1').toLowerCase();
}

function snakeToCamel(key) {
  return key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

function decodeRow(table, row) {
  if (!row) return row;
  if (BLOB_TABLES.has(table)) {
    try { return JSON.parse(row.data); } catch { return row; }
  }
  const jsonCols = JSON_COLUMNS[table];
  const convert = CASE_CONVERT_TABLES.has(table);
  const out = {};
  for (const [col, value] of Object.entries(row)) {
    const key = convert ? snakeToCamel(col) : col;
    out[key] = (jsonCols?.includes(col) && value != null) ? safeJsonParse(value) : value;
  }
  return out;
}

function safeJsonParse(value) {
  try { return JSON.parse(value); } catch { return value; }
}

function encodeRecord(table, record) {
  const jsonCols = JSON_COLUMNS[table] || [];
  const convert = CASE_CONVERT_TABLES.has(table);
  const out = {};
  for (const [key, value] of Object.entries(record)) {
    const col = convert ? camelToSnake(key) : key;
    out[col] = (jsonCols.includes(col) && value != null && typeof value !== 'string') ? JSON.stringify(value) : value;
  }
  return out;
}

function allowedColumns(table, { safe = false } = {}) {
  const cols = (safe && SAFE_COLUMNS[table]) ? SAFE_COLUMNS[table] : COLUMNS[table];
  if (!cols) throw new Error(`No column list for table: ${table}`);
  return cols;
}

export async function selectAll(env, table, { safe = false } = {}) {
  if (BLOB_TABLES.has(table)) {
    const { results } = await env.DB.prepare(`select data from ${table}`).all();
    return (results || []).map(r => decodeRow(table, r));
  }
  const cols = allowedColumns(table, { safe });
  const { results } = await env.DB.prepare(`select ${cols.join(',')} from ${table}`).all();
  return (results || []).map(r => decodeRow(table, r));
}

export async function selectOne(env, table, id, { safe = false } = {}) {
  const pk = pkColumn(table);
  if (BLOB_TABLES.has(table)) {
    const row = await env.DB.prepare(`select data from ${table} where ${pk} = ?`).bind(id).first();
    return row ? decodeRow(table, row) : null;
  }
  const cols = allowedColumns(table, { safe });
  const row = await env.DB.prepare(`select ${cols.join(',')} from ${table} where ${pk} = ?`).bind(id).first();
  return decodeRow(table, row);
}

export async function selectByIndex(env, table, indexName, value, { safe = false } = {}) {
  if (BLOB_TABLES.has(table)) {
    const all = await selectAll(env, table);
    return all.filter(r => r[snakeToCamel(indexName)] === value || r[indexName] === value);
  }
  const cols = allowedColumns(table, { safe });
  const col = CASE_CONVERT_TABLES.has(table) ? camelToSnake(indexName) : indexName;
  if (!COLUMNS[table]?.includes(col)) throw new Error(`Unknown column: ${indexName}`);
  const { results } = await env.DB.prepare(`select ${cols.join(',')} from ${table} where ${col} = ?`).bind(value).all();
  return (results || []).map(r => decodeRow(table, r));
}

function withGeneratedPk(table, encoded, pk) {
  if (pk === 'id' && !encoded.id) return { ...encoded, id: crypto.randomUUID() };
  return encoded;
}

export async function insertRow(env, table, record) {
  const pk = pkColumn(table);
  if (BLOB_TABLES.has(table)) {
    const withId = record.id ? record : { ...record, id: crypto.randomUUID() };
    await env.DB.prepare(`insert into ${table} (id, data) values (?, ?)`).bind(withId.id, JSON.stringify(withId)).run();
    return withId;
  }
  const encoded = withGeneratedPk(table, encodeRecord(table, record), pk);
  const cols = COLUMNS[table].filter(c => encoded[c] !== undefined);
  const placeholders = cols.map(() => '?').join(',');
  await env.DB.prepare(`insert into ${table} (${cols.join(',')}) values (${placeholders})`)
    .bind(...cols.map(c => encoded[c])).run();
  return selectOne(env, table, encoded[pk]);
}

export async function upsertRow(env, table, record) {
  const pk = pkColumn(table);
  if (BLOB_TABLES.has(table)) {
    const withId = record.id ? record : { ...record, id: crypto.randomUUID() };
    await env.DB.prepare(
      `insert into ${table} (id, data) values (?, ?)
       on conflict(id) do update set data = excluded.data`
    ).bind(withId.id, JSON.stringify(withId)).run();
    return withId;
  }
  const encoded = withGeneratedPk(table, encodeRecord(table, record), pk);
  const cols = COLUMNS[table].filter(c => encoded[c] !== undefined);
  const placeholders = cols.map(() => '?').join(',');
  const updates = cols.filter(c => c !== pk).map(c => `${c} = excluded.${c}`).join(',');
  await env.DB.prepare(
    `insert into ${table} (${cols.join(',')}) values (${placeholders})
     on conflict(${pk}) do update set ${updates}`
  ).bind(...cols.map(c => encoded[c])).run();
  return selectOne(env, table, encoded[pk]);
}

// A sequential loop of individual upsertRow() calls does two D1 round-trips
// per record (insert + a read-back select) — for a few hundred HR/Accounts
// rows that blows past the Workers subrequest cap and crashes with an
// unhandled 500. Build every statement up front and send them in one
// env.DB.batch() call instead: a single round-trip for the whole chunk.
export async function bulkUpsert(env, table, records) {
  if (!records.length) return 0;
  const pk = pkColumn(table);

  const statements = records.map(record => {
    if (BLOB_TABLES.has(table)) {
      const withId = record.id ? record : { ...record, id: crypto.randomUUID() };
      return env.DB.prepare(
        `insert into ${table} (id, data) values (?, ?)
         on conflict(id) do update set data = excluded.data`
      ).bind(withId.id, JSON.stringify(withId));
    }
    const encoded = withGeneratedPk(table, encodeRecord(table, record), pk);
    const cols = COLUMNS[table].filter(c => encoded[c] !== undefined);
    const placeholders = cols.map(() => '?').join(',');
    const updates = cols.filter(c => c !== pk).map(c => `${c} = excluded.${c}`).join(',');
    return env.DB.prepare(
      `insert into ${table} (${cols.join(',')}) values (${placeholders})
       on conflict(${pk}) do update set ${updates}`
    ).bind(...cols.map(c => encoded[c]));
  });

  await env.DB.batch(statements);
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
