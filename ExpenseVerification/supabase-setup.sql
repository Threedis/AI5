-- ══════════════════════════════════════════════════════════
-- ExpenseVerify — Supabase Database Setup
-- Run this ONCE in: Supabase Dashboard → SQL Editor → Run
-- ══════════════════════════════════════════════════════════

-- 1. Profiles (extends Supabase auth.users)
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  username     text unique not null,
  display_name text,
  email        text,
  role         text not null default 'user' check (role in ('admin','hr','accounts','user')),
  department   text,
  status       text not null default 'active',
  created_at   timestamptz default now()
);
alter table public.profiles enable row level security;
create policy "Users can read all profiles" on public.profiles for select using (true);
create policy "Users can update own profile" on public.profiles for update using (auth.uid() = id);
create policy "Admin full access" on public.profiles for all using (
  exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
);

-- 2. HR Master
create table if not exists public.hr_master (
  id                 uuid primary key default gen_random_uuid(),
  employee_id        text not null,
  employee_name      text,
  month              text,
  year               text,
  branch             text,
  division           text,
  bank_name          text,
  bank_account_number text,
  ifsc               text,
  name_in_bank       text,
  batch_id           text,
  version            text,
  created_at         timestamptz default now()
);
alter table public.hr_master enable row level security;
create policy "Authenticated read hr_master" on public.hr_master for select using (auth.role() = 'authenticated');
create policy "HR/Admin write hr_master" on public.hr_master for all using (
  exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','hr'))
);
create index if not exists hr_master_employee_id_idx on public.hr_master(employee_id);

-- 3. Accounts Master
create table if not exists public.accounts_master (
  id          uuid primary key default gen_random_uuid(),
  emp_code    text not null,
  emp_name    text,
  bank_name   text,
  account_no  text,
  ifsc        text,
  net_pay     numeric,
  section     text,
  name_in_bank text,
  batch_id    text,
  sheet       text,
  created_at  timestamptz default now()
);
alter table public.accounts_master enable row level security;
create policy "Authenticated read accounts_master" on public.accounts_master for select using (auth.role() = 'authenticated');
create policy "Accounts/Admin write accounts_master" on public.accounts_master for all using (
  exists (select 1 from public.profiles where id = auth.uid() and role in ('admin','accounts'))
);
create index if not exists accounts_master_emp_code_idx on public.accounts_master(emp_code);

-- 4. Audit Logs
create table if not exists public.audit_logs (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id),
  username   text,
  module     text,
  action     text,
  status     text,
  detail     text,
  ip         text,
  created_at timestamptz default now()
);
alter table public.audit_logs enable row level security;
create policy "Authenticated insert audit" on public.audit_logs for insert with check (auth.role() = 'authenticated');
create policy "Admin read audit" on public.audit_logs for select using (
  exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
);

-- 5. Settings
create table if not exists public.settings (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz default now()
);
alter table public.settings enable row level security;
create policy "Authenticated read settings" on public.settings for select using (auth.role() = 'authenticated');
create policy "Admin write settings" on public.settings for all using (
  exists (select 1 from public.profiles where id = auth.uid() and role = 'admin')
);

-- 6. Verification Sessions
create table if not exists public.verifications (
  id          uuid primary key default gen_random_uuid(),
  created_by  text,
  source      text,
  pdf_file    text,
  summary     jsonb,
  results     jsonb,
  created_at  timestamptz default now()
);
alter table public.verifications enable row level security;
create policy "Authenticated access verifications" on public.verifications for all using (auth.role() = 'authenticated');

-- 7. Version History
create table if not exists public.version_history (
  id         uuid primary key default gen_random_uuid(),
  type       text,
  version    text,
  detail     jsonb,
  created_at timestamptz default now()
);
alter table public.version_history enable row level security;
create policy "Authenticated access version_history" on public.version_history for all using (auth.role() = 'authenticated');

-- 8. Accounts Batches
create table if not exists public.accounts_batches (
  id         uuid primary key default gen_random_uuid(),
  batch_no   text,
  is_active  boolean default false,
  detail     jsonb,
  created_at timestamptz default now()
);
alter table public.accounts_batches enable row level security;
create policy "Authenticated access accounts_batches" on public.accounts_batches for all using (auth.role() = 'authenticated');

-- ══════════════════════════════════════════════════════════
-- DEFAULT ADMIN USER
-- After running this SQL, go to:
-- Supabase → Authentication → Users → Add User
--   Email:    admin@expenseverify.local
--   Password: Admin@1234
-- Then run this INSERT to link the profile:
-- ══════════════════════════════════════════════════════════
-- INSERT INTO public.profiles (id, username, display_name, email, role)
-- VALUES ('<paste-user-id-from-auth-users>', 'admin', 'System Administrator', 'admin@expenseverify.local', 'admin');
