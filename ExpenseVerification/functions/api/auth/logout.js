import { parseCookies, destroySession, sessionCookieHeader, isHttps } from '../_lib/auth.js';

export async function onRequestPost({ request, env }) {
  const token = parseCookies(request).evs_session;
  await destroySession(env, token);
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Set-Cookie': sessionCookieHeader(null, { clear: true, secure: isHttps(request) }) },
  });
}
