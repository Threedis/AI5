import { requireUser } from '../_lib/auth.js';

// Atomically increments a named counter stored in the settings table and
// returns the new value. Deliberately open to any authenticated user (not
// admin-only like the generic /api/settings/:key endpoint) — generating a
// SAL/NES file is a Verification-page action available to every role, and
// the 275T{SAL,NES}{DDMM}.{SERIAL} filename spec requires one shared,
// continuously-incrementing serial across both file types. Admins can still
// view/correct the current value via Admin → Settings, since it's stored
// under the same settings key.
//
// Restricted to this allowlist — otherwise any authenticated user could pass
// an arbitrary key (e.g. "zohoClientId") and clobber an admin-only setting
// by "incrementing" it.
const ALLOWED_COUNTERS = new Set(['salNesSerial']);

export async function onRequestPost({ request, env }) {
  const { error } = await requireUser(request, env);
  if (error) return error;

  const { key } = await request.json();
  if (!ALLOWED_COUNTERS.has(key)) return new Response(JSON.stringify({ error: 'Unknown counter' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  await env.DB.prepare(
    `insert into settings (key, value, updated_at) values (?, '0', datetime('now'))
     on conflict(key) do nothing`
  ).bind(key).run();

  const row = await env.DB.prepare(
    `update settings set value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = datetime('now')
     where key = ? returning value`
  ).bind(key).first();

  return new Response(JSON.stringify({ serial: parseInt(row.value, 10) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
