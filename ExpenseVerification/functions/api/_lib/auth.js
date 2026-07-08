/**
 * auth.js — password hashing (PBKDF2 via Web Crypto, no native bcrypt at the
 * edge) and cookie-backed sessions stored in D1 (so logout is a real revoke,
 * not just "let the JWT expire").
 */

const SESSION_COOKIE = 'evs_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PBKDF2_ITERATIONS = 100000;

function toHex(buf) {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function deriveBits(password, saltBytes) {
  const keyMaterial = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial, 256
  );
  return toHex(bits);
}

export async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveBits(password, saltBytes);
  return { hash, salt: toHex(saltBytes) };
}

export async function verifyPassword(password, hash, salt) {
  const computed = await deriveBits(password, fromHex(salt));
  if (computed.length !== hash.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export function isHttps(request) {
  return new URL(request.url).protocol === 'https:';
}

export function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// `secure` is left off for plain-http requests (e.g. `wrangler pages dev`
// on localhost) since browsers silently drop Secure cookies on non-https
// origins; production traffic through Cloudflare Pages is always https.
export function sessionCookieHeader(token, { clear = false, secure = true } = {}) {
  const maxAge = clear ? 0 : Math.floor(SESSION_TTL_MS / 1000);
  const value = clear ? '' : token;
  const secureAttr = secure ? ' Secure;' : '';
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly;${secureAttr} SameSite=Lax; Max-Age=${maxAge}`;
}

export async function createSession(env, userId) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await env.DB.prepare('insert into sessions (token, user_id, expires_at) values (?, ?, ?)')
    .bind(token, userId, expiresAt).run();
  return token;
}

export async function destroySession(env, token) {
  if (!token) return;
  await env.DB.prepare('delete from sessions where token = ?').bind(token).run();
}

const PROFILE_SAFE_COLUMNS = ['id', 'username', 'display_name', 'email', 'role', 'department', 'status', 'created_at'];

// the frontend (admin.html, dashboard.html, ...) reads profile fields as
// camelCase (sess.displayName), while SQL columns are snake_case.
export function toCamelRow(row) {
  if (!row) return row;
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    out[key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase())] = value;
  }
  return out;
}

/** Resolve the logged-in profile (safe columns only) from the request's session cookie, or null. */
export async function getSessionUser(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const cols = PROFILE_SAFE_COLUMNS.map(c => `p.${c}`).join(', ');
  const row = await env.DB.prepare(
    `select ${cols}, s.expires_at
       from sessions s join profiles p on p.id = s.user_id
      where s.token = ?`
  ).bind(token).first();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await destroySession(env, token);
    return null;
  }
  delete row.expires_at;
  return toCamelRow(row);
}

/** Require a logged-in user, optionally restricted to a set of roles. Returns { user } or { error: Response }. */
export async function requireUser(request, env, allowedRoles = null) {
  const user = await getSessionUser(request, env);
  if (!user) return { error: new Response(JSON.stringify({ error: 'Not authenticated' }), { status: 401, headers: { 'Content-Type': 'application/json' } }) };
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    return { error: new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } }) };
  }
  return { user };
}
