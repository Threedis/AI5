/**
 * zoho-proxy — Local Express server that proxies Zoho Projects API requests.
 * Credentials are read from environment variables; the browser never handles tokens.
 *
 * Usage:
 *   ZOHO_ACCESS_TOKEN=<token> node server.js
 *   # Optional overrides:
 *   ZOHO_PORTAL_ID=hbegroupprojects ZOHO_PROJECT_ID=<id> node server.js
 *
 * Then open the app at http://localhost:3000/user.html
 */

const http    = require('http');
const https   = require('https');
const url     = require('url');
const path    = require('path');
const fs      = require('fs');

const PORT        = process.env.PORT         || 3000;
const ACCESS_TOKEN = process.env.ZOHO_ACCESS_TOKEN || '';
const PORTAL_ID   = process.env.ZOHO_PORTAL_ID    || 'hbegroupprojects';
const PROJECT_ID  = process.env.ZOHO_PROJECT_ID   || '';

if (!ACCESS_TOKEN) {
  console.warn('[zoho-proxy] WARNING: ZOHO_ACCESS_TOKEN not set. /api/zoho/* calls will fail with 401.');
}

/* ── MIME types for static file serving ───────────────────── */
const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

/* ── Zoho API helper ──────────────────────────────────────── */
function zohoGet(apiPath) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'projectsapi.zoho.com',
      path:     `/restapi${apiPath}`,
      method:   'GET',
      headers:  { 'Authorization': `Zoho-oauthtoken ${ACCESS_TOKEN}` },
    };
    const req = https.request(opts, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 401) { reject({ status: 401, message: 'Zoho access token is invalid or expired.' }); return; }
        if (res.statusCode === 403) { reject({ status: 403, message: 'Zoho access denied — check token scopes.' }); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject({ status: res.statusCode, message: `Zoho API error ${res.statusCode}: ${body.slice(0, 200)}` }); return;
        }
        try { resolve(JSON.parse(body)); }
        catch { reject({ status: 500, message: 'Invalid JSON from Zoho API' }); }
      });
    });
    req.on('error', err => reject({ status: 502, message: `Network error: ${err.message}` }));
    req.end();
  });
}

/* ── Task search / fetch ──────────────────────────────────── */
async function fetchZohoTask(taskId) {
  // Try direct task endpoint if project ID is known
  if (PROJECT_ID) {
    try {
      const data = await zohoGet(`/portal/${encodeURIComponent(PORTAL_ID)}/projects/${encodeURIComponent(PROJECT_ID)}/tasks/${encodeURIComponent(taskId)}/`);
      return data;
    } catch (e) {
      if (e.status !== 404) throw e;
      // fall through to portal-wide search
    }
  }
  // Portal-wide search by task ID string
  return zohoGet(`/portal/${encodeURIComponent(PORTAL_ID)}/tasks/?search_term=${encodeURIComponent(taskId)}`);
}

async function fetchZohoComments(taskId, projectId) {
  const pid = projectId || PROJECT_ID;
  if (!pid) return { comments: [] };
  try {
    return await zohoGet(`/portal/${encodeURIComponent(PORTAL_ID)}/projects/${encodeURIComponent(pid)}/tasks/${encodeURIComponent(taskId)}/comments/`);
  } catch { return { comments: [] }; }
}

/* ── HTTP server ──────────────────────────────────────────── */
const server = http.createServer(async (req, res) => {
  const parsed   = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS — allow same-origin + GitHub Pages
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* ── API routes ─────────────────────────────────────────── */
  if (pathname.startsWith('/api/zoho/task/')) {
    const taskId = decodeURIComponent(pathname.slice('/api/zoho/task/'.length));
    if (!taskId) { sendJSON(res, 400, { error: 'Task ID required' }); return; }
    if (!ACCESS_TOKEN) { sendJSON(res, 503, { error: 'Server not configured: ZOHO_ACCESS_TOKEN missing.' }); return; }

    try {
      const data = await fetchZohoTask(taskId);
      sendJSON(res, 200, data);
    } catch (err) {
      sendJSON(res, err.status || 500, { error: err.message });
    }
    return;
  }

  if (pathname.startsWith('/api/zoho/comments/')) {
    const parts     = pathname.slice('/api/zoho/comments/'.length).split('/');
    const taskId    = decodeURIComponent(parts[0] || '');
    const projectId = decodeURIComponent(parts[1] || '');
    if (!taskId) { sendJSON(res, 400, { error: 'Task ID required' }); return; }
    if (!ACCESS_TOKEN) { sendJSON(res, 503, { error: 'Server not configured: ZOHO_ACCESS_TOKEN missing.' }); return; }

    try {
      const data = await fetchZohoComments(taskId, projectId);
      sendJSON(res, 200, data);
    } catch (err) {
      sendJSON(res, err.status || 500, { error: err.message });
    }
    return;
  }

  if (pathname === '/api/zoho/status') {
    sendJSON(res, 200, {
      configured: !!ACCESS_TOKEN,
      portalId:   PORTAL_ID,
      hasProject: !!PROJECT_ID,
    });
    return;
  }

  /* ── Static file serving ────────────────────────────────── */
  let filePath = pathname === '/' ? '/user.html' : pathname;
  filePath = path.join(__dirname, filePath);

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    const ext  = path.extname(filePath).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  });
});

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

server.listen(PORT, () => {
  console.log(`[zoho-proxy] Listening on http://localhost:${PORT}`);
  console.log(`[zoho-proxy] Portal: ${PORTAL_ID}${PROJECT_ID ? ` | Project: ${PROJECT_ID}` : ''}`);
  console.log(`[zoho-proxy] Token : ${ACCESS_TOKEN ? '*** set ***' : 'NOT SET (set ZOHO_ACCESS_TOKEN env var)'}`);
  console.log(`[zoho-proxy] Open  : http://localhost:${PORT}/user.html`);
});
