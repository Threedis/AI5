/**
 * Repo-root Worker entry point.
 *
 * This deployment serves the whole repo as static assets (so ExpenseVerification/
 * pages keep working at /ExpenseVerification/...), plus a manual router for
 * /api/* that dispatches to the same handler modules used by the Cloudflare
 * Pages Functions build (ExpenseVerification/functions/api/**), since a plain
 * Worker doesn't get that file-based routing convention for free.
 */

import * as login from '../ExpenseVerification/functions/api/auth/login.js';
import * as logout from '../ExpenseVerification/functions/api/auth/logout.js';
import * as session from '../ExpenseVerification/functions/api/auth/session.js';
import * as changePassword from '../ExpenseVerification/functions/api/auth/change-password.js';
import * as profile from '../ExpenseVerification/functions/api/auth/profile.js';
import * as usersIndex from '../ExpenseVerification/functions/api/auth/users/index.js';
import * as usersId from '../ExpenseVerification/functions/api/auth/users/[id].js';
import * as dataIndex from '../ExpenseVerification/functions/api/data/[store]/index.js';
import * as dataId from '../ExpenseVerification/functions/api/data/[store]/[id].js';
import * as dataCount from '../ExpenseVerification/functions/api/data/[store]/count.js';
import * as dataBulk from '../ExpenseVerification/functions/api/data/[store]/bulk.js';
import * as settingsKey from '../ExpenseVerification/functions/api/settings/[key].js';

// Ordered so more specific literal segments (count/bulk) are tried before
// the generic :id catch-all — same precedence Pages' file-based router gives
// count.js/bulk.js over [id].js.
const ROUTES = [
  { method: 'POST',   pattern: '/api/auth/login',                 handler: login.onRequestPost },
  { method: 'POST',   pattern: '/api/auth/logout',                handler: logout.onRequestPost },
  { method: 'GET',    pattern: '/api/auth/session',                handler: session.onRequestGet },
  { method: 'POST',   pattern: '/api/auth/change-password',        handler: changePassword.onRequestPost },
  { method: 'PATCH',  pattern: '/api/auth/profile',                handler: profile.onRequestPatch },
  { method: 'GET',    pattern: '/api/auth/users',                  handler: usersIndex.onRequestGet },
  { method: 'POST',   pattern: '/api/auth/users',                  handler: usersIndex.onRequestPost },
  { method: 'PATCH',  pattern: '/api/auth/users/:id',               handler: usersId.onRequestPatch },
  { method: 'DELETE', pattern: '/api/auth/users/:id',               handler: usersId.onRequestDelete },
  { method: 'GET',    pattern: '/api/data/:store/count',            handler: dataCount.onRequestGet },
  { method: 'POST',   pattern: '/api/data/:store/bulk',             handler: dataBulk.onRequestPost },
  { method: 'GET',    pattern: '/api/data/:store/:id',              handler: dataId.onRequestGet },
  { method: 'DELETE', pattern: '/api/data/:store/:id',              handler: dataId.onRequestDelete },
  { method: 'GET',    pattern: '/api/data/:store',                  handler: dataIndex.onRequestGet },
  { method: 'POST',   pattern: '/api/data/:store',                  handler: dataIndex.onRequestPost },
  { method: 'PUT',    pattern: '/api/data/:store',                  handler: dataIndex.onRequestPut },
  { method: 'DELETE', pattern: '/api/data/:store',                  handler: dataIndex.onRequestDelete },
  { method: 'GET',    pattern: '/api/settings/:key',                handler: settingsKey.onRequestGet },
  { method: 'PUT',    pattern: '/api/settings/:key',                handler: settingsKey.onRequestPut },
];

function matchRoute(method, pathname) {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const routeParts = route.pattern.split('/').filter(Boolean);
    const pathParts = pathname.split('/').filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;

    const params = {};
    let matched = true;
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) {
        params[routeParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
      } else if (routeParts[i] !== pathParts[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return { handler: route.handler, params };
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      const match = matchRoute(request.method, url.pathname);
      if (!match) {
        return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
      }
      return match.handler({ request, env, ctx, params: match.params });
    }

    return env.ASSETS.fetch(request);
  },
};
