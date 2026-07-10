import { requireUser } from '../../_lib/auth.js';
import { canWrite } from '../../_lib/rules.js';
import { tbl, bulkUpsert } from '../../_lib/db.js';

export async function onRequestPost({ request, env, params }) {
  const store = params.store;
  const { user } = await requireUser(request, env);
  if (!canWrite(store, user)) {
    return new Response(JSON.stringify({ error: 'Forbidden' }), { status: user ? 403 : 401, headers: { 'Content-Type': 'application/json' } });
  }
  const records = await request.json();
  try {
    const written = await bulkUpsert(env, tbl(store), Array.isArray(records) ? records : []);
    return new Response(JSON.stringify({ written }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || String(err) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
