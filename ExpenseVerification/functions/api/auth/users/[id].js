import { requireUser, hashPassword } from '../../_lib/auth.js';

const UPDATABLE = ['display_name', 'role', 'department', 'status'];

export async function onRequestPatch({ request, env, params }) {
  const { error } = await requireUser(request, env, ['admin']);
  if (error) return error;

  const body = await request.json();
  const sets = [];
  const values = [];
  for (const col of UPDATABLE) {
    const value = col === 'display_name' && body.displayName !== undefined ? body.displayName : body[col];
    if (value !== undefined) { sets.push(`${col} = ?`); values.push(value); }
  }
  if (body.password) {
    if (body.password.length < 8) {
      return new Response(JSON.stringify({ error: 'Password must be ≥ 8 chars.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const { hash, salt } = await hashPassword(body.password);
    sets.push('password_hash = ?', 'password_salt = ?');
    values.push(hash, salt);
  }
  if (!sets.length) return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  values.push(params.id);
  await env.DB.prepare(`update profiles set ${sets.join(', ')} where id = ?`).bind(...values).run();
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestDelete({ request, env, params }) {
  const { error } = await requireUser(request, env, ['admin']);
  if (error) return error;
  await env.DB.prepare('delete from profiles where id = ?').bind(params.id).run();
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
