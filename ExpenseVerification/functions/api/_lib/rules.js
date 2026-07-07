/**
 * rules.js — per-store authorization, reimplementing the 14 Postgres RLS
 * policies from supabase-setup.sql as explicit request-time checks (D1 has
 * no RLS equivalent). Keyed by the same store names the frontend's
 * Database.TABLE map uses. `'authenticated'` means "any logged-in user";
 * an array means only those roles.
 *
 * Source policies (supabase-setup.sql):
 *   profiles          — read: using(true) / write: admin only (self-update handled separately)
 *   hr_master         — read: authenticated / write: admin, hr
 *   accounts_master   — read: authenticated / write: admin, accounts
 *   audit_logs        — read: admin only   / write(insert): authenticated
 *   settings          — read: authenticated / write: admin only
 *   verifications, version_history, accounts_batches — read+write: authenticated
 */
export const RULES = {
  users:           { read: 'authenticated', write: ['admin'] },
  hrMaster:        { read: 'authenticated', write: ['admin', 'hr'] },
  accountsMaster:  { read: 'authenticated', write: ['admin', 'accounts'] },
  auditLogs:       { read: ['admin'],       write: 'authenticated' },
  settings:        { read: 'authenticated', write: ['admin'] },
  verifications:   { read: 'authenticated', write: 'authenticated' },
  versionHistory:  { read: 'authenticated', write: 'authenticated' },
  accountsBatches: { read: 'authenticated', write: 'authenticated' },
};

/** Returns true if `user` (or null, if unauthenticated) satisfies `requirement`. */
export function satisfies(user, requirement) {
  if (!user) return false;
  if (requirement === 'authenticated') return true;
  return requirement.includes(user.role);
}

export function canRead(store, user) {
  const rule = RULES[store];
  if (!rule) return false;
  return satisfies(user, rule.read);
}

export function canWrite(store, user) {
  const rule = RULES[store];
  if (!rule) return false;
  return satisfies(user, rule.write);
}
