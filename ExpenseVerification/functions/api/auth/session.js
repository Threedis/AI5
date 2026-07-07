import { getSessionUser } from '../_lib/auth.js';

export async function onRequestGet({ request, env }) {
  const user = await getSessionUser(request, env);
  if (!user) return new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  return new Response(JSON.stringify({ profile: user }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
