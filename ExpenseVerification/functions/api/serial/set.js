import { requireUser } from '../_lib/auth.js';

// Explicitly sets a named counter, e.g. the 275TSAL/NES last-serial-used
// value on the Verification page. Open to any authenticated user (not
// admin-only) — restricted to an explicit allowlist so it can't be used to
// overwrite unrelated settings like zohoClientId.
const ALLOWED_COUNTERS = new Set(['salNesSerial']);

export async function onRequestPost({ request, env }) {
  const { error } = await requireUser(request, env);
  if (error) return error;

  const { key, value } = await request.json();
  if (!ALLOWED_COUNTERS.has(key)) return new Response(JSON.stringify({ error: 'Unknown counter' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  const n = parseInt(value, 10);
  if (!Number.isFinite(n) || n < 1) return new Response(JSON.stringify({ error: 'value must be a whole number, 1 or higher' }), { status: 400, headers: { 'Content-Type': 'application/json' } });

  await env.DB.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, datetime('now'))
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).bind(key, String(n)).run();

  return new Response(JSON.stringify({ serial: n }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
