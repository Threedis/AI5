import { requireUser } from '../../_lib/auth.js';
import { canRead } from '../../_lib/rules.js';
import { tbl, countRows } from '../../_lib/db.js';

export async function onRequestGet({ request, env, params }) {
  const store = params.store;
  const { user } = await requireUser(request, env);
  if (!canRead(store, user)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: user ? 403 : 401, headers: { 'Content-Type': 'application/json' } });
  }
  const count = await countRows(env, tbl(store));
  return new Response(JSON.stringify({ count }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
