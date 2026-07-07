-- ══════════════════════════════════════════════════════════
-- ExpenseVerify — Cloudflare D1 schema
-- Apply with: wrangler d1 execute <DB_NAME> --file=schema.sql
-- (add --local when testing against `wrangler pages dev`)
-- ══════════════════════════════════════════════════════════

PRAGMA foreign_keys = ON;

-- Replaces Supabase Auth. Auth credentials live alongside profile data —
-- the generic /api/data/profiles endpoint always excludes password_hash/salt.
create table if not exists profiles (
  id             text primary key,
  username       text unique not null,
  password_hash  text not null,
  password_salt  text not null,
  display_name   text,
  email          text,
  role           text not null default 'user' check (role in ('admin','hr','accounts','user')),
  department     text,
  status         text not null default 'active',
  created_at     text default (datetime('now'))
);

-- Replaces Supabase's built-in session/JWT handling. One row per active
-- login; deleting the row is what makes logout an immediate, real revoke.
create table if not exists sessions (
  token      text primary key,
  user_id    text not null references profiles(id) on delete cascade,
  expires_at text not null,
  created_at text default (datetime('now'))
);
create index if not exists sessions_user_id_idx on sessions(user_id);

create table if not exists hr_master (
  id                  text primary key,
  employee_id         text not null,
  employee_name       text,
  month               text,
  year                text,
  branch              text,
  division            text,
  bank_name           text,
  bank_account_number text,
  ifsc                text,
  name_in_bank        text,
  batch_id            text,
  version             text,
  created_at          text default (datetime('now'))
);
create index if not exists hr_master_employee_id_idx on hr_master(employee_id);

create table if not exists accounts_master (
  id           text primary key,
  emp_code     text not null,
  emp_name     text,
  bank_name    text,
  account_no   text,
  ifsc         text,
  net_pay      real,
  section      text,
  name_in_bank text,
  batch_id     text,
  sheet        text,
  created_at   text default (datetime('now'))
);
create index if not exists accounts_master_emp_code_idx on accounts_master(emp_code);

create table if not exists audit_logs (
  id         text primary key,
  user_id    text references profiles(id),
  username   text,
  module     text,
  action     text,
  status     text,
  detail     text,
  ip         text,
  created_at text default (datetime('now'))
);

-- value stored as JSON-stringified text (SQLite has no jsonb); parsed/
-- serialized in functions/api/_lib/db.js.
create table if not exists settings (
  key        text primary key,
  value      text,
  updated_at text default (datetime('now'))
);

create table if not exists verifications (
  id         text primary key,
  created_by text,
  source     text,
  pdf_file   text,
  summary    text,
  results    text,
  created_at text default (datetime('now'))
);

create table if not exists version_history (
  id         text primary key,
  type       text,
  version    text,
  detail     text,
  created_at text default (datetime('now'))
);

create table if not exists accounts_batches (
  id         text primary key,
  batch_no   text,
  is_active  integer default 0,
  detail     text,
  created_at text default (datetime('now'))
);
