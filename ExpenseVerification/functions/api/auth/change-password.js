import { requireUser, hashPassword } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const { user, error } = await requireUser(request, env);
  if (error) return error;

  const { newPassword } = await request.json();
  if (!newPassword || newPassword.length < 8) {
    return new Response(JSON.stringify({ error: 'Password must be ≥ 8 chars.' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const { hash, salt } = await hashPassword(newPassword);
  await env.DB.prepare('update profiles set password_hash = ?, password_salt = ? where id = ?')
    .bind(hash, salt, user.id).run();

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
