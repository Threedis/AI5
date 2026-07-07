import { requireUser } from '../../_lib/auth.js';
import { canRead, canWrite } from '../../_lib/rules.js';
import { tbl, selectOne, deleteRow } from '../../_lib/db.js';

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env, params }) {
  const store = params.store;
  const { user } = await requireUser(request, env);
  if (!canRead(store, user)) return jsonRes({ error: 'Forbidden' }, user ? 403 : 401);

  const row = await selectOne(env, tbl(store), params.id, { safe: store === 'users' });
  return jsonRes({ data: row || null });
}

export async function onRequestDelete({ request, env, params }) {
  const store = params.store;
  const { user } = await requireUser(request, env);
  if (!canWrite(store, user)) return jsonRes({ error: 'Forbidden' }, user ? 403 : 401);

  await deleteRow(env, tbl(store), params.id);
  return jsonRes({ ok: true });
}
