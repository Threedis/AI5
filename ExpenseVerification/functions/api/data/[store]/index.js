import { requireUser } from '../../_lib/auth.js';
import { canRead, canWrite } from '../../_lib/rules.js';
import { tbl, selectAll, selectByIndex, insertRow, upsertRow, deleteAll } from '../../_lib/db.js';

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestGet({ request, env, params }) {
  const store = params.store;
  const { user } = await requireUser(request, env);
  if (!canRead(store, user)) return jsonRes({ error: 'Forbidden' }, user ? 403 : 401);

  const table = tbl(store);
  const safe = store === 'users';
  const url = new URL(request.url);
  const index = url.searchParams.get('index');
  const value = url.searchParams.get('value');

  const rows = index
    ? await selectByIndex(env, table, index, value, { safe })
    : await selectAll(env, table, { safe });
  return jsonRes({ data: rows });
}

export async function onRequestPost({ request, env, params }) {
  const store = params.store;
  const { user } = await requireUser(request, env);
  if (!canWrite(store, user)) return jsonRes({ error: 'Forbidden' }, user ? 403 : 401);

  const record = await request.json();
  const row = await insertRow(env, tbl(store), record);
  return jsonRes({ data: row }, 201);
}

export async function onRequestPut({ request, env, params }) {
  const store = params.store;
  const { user } = await requireUser(request, env);
  if (!canWrite(store, user)) return jsonRes({ error: 'Forbidden' }, user ? 403 : 401);

  const record = await request.json();
  const row = await upsertRow(env, tbl(store), record);
  return jsonRes({ data: row });
}

export async function onRequestDelete({ request, env, params }) {
  const store = params.store;
  const { user } = await requireUser(request, env);
  if (!canWrite(store, user)) return jsonRes({ error: 'Forbidden' }, user ? 403 : 401);

  await deleteAll(env, tbl(store));
  return jsonRes({ ok: true });
}
