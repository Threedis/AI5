import { requireUser } from '../_lib/auth.js';

// Self-service profile update — deliberately excludes role/status (those
// stay admin-only via /api/auth/users/:id) so a user can't escalate privileges.
const SELF_UPDATABLE = { display_name: 'display_name', displayName: 'display_name', department: 'department' };

export async function onRequestPatch({ request, env }) {
  const { user, error } = await requireUser(request, env);
  if (error) return error;

  const body = await request.json();
  const sets = [];
  const values = [];
  for (const [key, col] of Object.entries(SELF_UPDATABLE)) {
    if (body[key] !== undefined && !sets.some(s => s.startsWith(col))) { sets.push(`${col} = ?`); values.push(body[key]); }
  }
  if (sets.length) {
    values.push(user.id);
    await env.DB.prepare(`update profiles set ${sets.join(', ')} where id = ?`).bind(...values).run();
  }
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
