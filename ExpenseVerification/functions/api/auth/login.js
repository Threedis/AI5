import { verifyPassword, createSession, sessionCookieHeader, isHttps } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const { username, password } = await request.json();
  if (!username || !password) {
    return new Response(JSON.stringify({ error: 'Username and password required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const row = await env.DB.prepare(
    'select id, username, password_hash, password_salt, display_name, email, role, department, status, created_at from profiles where username = ?'
  ).bind(username.trim()).first();

  if (!row || !(await verifyPassword(password, row.password_hash, row.password_salt))) {
    return new Response(JSON.stringify({ error: 'Invalid username or password' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  const token = await createSession(env, row.id);
  const { password_hash, password_salt, ...profile } = row;

  return new Response(JSON.stringify({ profile }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookieHeader(token, { secure: isHttps(request) }) },
  });
}
