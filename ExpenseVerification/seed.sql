-- ══════════════════════════════════════════════════════════
-- ExpenseVerify — bootstrap admin user
-- Run once, after schema.sql:
--   npx wrangler d1 execute <DB_NAME> --file=seed.sql
--   (add --local when testing against `wrangler pages dev`)
--
-- Login:    admin / Admin@1234
-- CHANGE THIS PASSWORD immediately after first login (Admin Panel →
-- edit the admin user, or self-service change-password once wired into
-- the UI) — this hash is public, it's checked into source control.
-- ══════════════════════════════════════════════════════════

insert into profiles (id, username, password_hash, password_salt, display_name, role, status)
values (
  lower(hex(randomblob(16))),
  'admin',
  '8ea78d166a2cd3b897f4ecb503f8d84504a4b8b21b2b714e78630f88c504150c',
  'e13d627b9c975d7048939b49d158d0e1',
  'System Administrator',
  'admin',
  'active'
);
