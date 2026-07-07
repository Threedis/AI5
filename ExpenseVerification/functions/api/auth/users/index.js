import { requireUser, hashPassword } from '../../_lib/auth.js';
import { selectAll } from '../../_lib/db.js';

export async function onRequestGet({ request, env }) {
  const { error } = await requireUser(request, env, ['admin']);
  if (error) return error;
  const users = await selectAll(env, 'profiles', { safe: true });
  return new Response(JSON.stringify({ users }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function onRequestPost({ request, env }) {
  const { error } = await requireUser(request, env, ['admin']);
  if (error) return error;

  const { username, password, role, displayName, department, status } = await request.json();
  if (!username || !password) {
    return new Response(JSON.stringify({ error: 'Username and password required.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const existing = await env.DB.prepare('select id from profiles where username = ?').bind(username.trim()).first();
  if (existing) {
    return new Response(JSON.stringify({ error: 'Username already exists.' }), { status: 409, headers: { 'Content-Type': 'application/json' } });
  }

  const { hash, salt } = await hashPassword(password);
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `insert into profiles (id, username, password_hash, password_salt, display_name, role, department, status)
     values (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, username.trim(), hash, salt, displayName || null, role || 'user', department || null, status || 'active').run();

  return new Response(JSON.stringify({ id }), { status: 201, headers: { 'Content-Type': 'application/json' } });
}
