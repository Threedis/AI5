import { requireUser } from '../_lib/auth.js';
import { canRead, canWrite } from '../_lib/rules.js';

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env, params }) {
  const { user } = await requireUser(request, env);
  if (!canRead('settings', user)) return jsonRes({ error: 'Forbidden' }, user ? 403 : 401);

  const row = await env.DB.prepare('select value from settings where key = ?').bind(params.key).first();
  if (!row) return jsonRes({ value: null });
  let value = null;
  try { value = JSON.parse(row.value); } catch { value = row.value; }
  return jsonRes({ value });
}

export async function onRequestPut({ request, env, params }) {
  const { user } = await requireUser(request, env);
  if (!canWrite('settings', user)) return jsonRes({ error: 'Forbidden' }, user ? 403 : 401);

  const { value } = await request.json();
  await env.DB.prepare(
    `insert into settings (key, value, updated_at) values (?, ?, datetime('now'))
     on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`
  ).bind(params.key, JSON.stringify(value)).run();
  return jsonRes({ ok: true });
}
