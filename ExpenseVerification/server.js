/**
 * zoho-proxy — Local MCP-aware proxy server for Expense Verification.
 *
 * Routes Zoho Projects task lookups through the Zoho MCP server process
 * instead of calling the Zoho REST API directly, so credentials are managed
 * entirely by the MCP server (OAuth flow, token refresh, etc.).
 *
 * ─── Prerequisites ────────────────────────────────────────────────────────
 *   npm install          # installs @modelcontextprotocol/sdk
 *
 * ─── Usage ────────────────────────────────────────────────────────────────
 *   node server.js
 *
 *   Optional env overrides:
 *     PORT=3000                        # HTTP port (default 3000)
 *     ZOHO_MCP_CMD=zoho-projects-mcp  # MCP server command (see below)
 *     ZOHO_MCP_ARGS=--arg1,--arg2     # comma-separated args for MCP command
 *     ZOHO_PORTAL_NAME=hbegroupprojects
 *     ZOHO_PROJECT_ID=<id>            # optional — narrows task search
 *
 * ─── MCP server command ───────────────────────────────────────────────────
 *   The proxy spawns whatever command is in ZOHO_MCP_CMD as a stdio MCP
 *   server. Common options:
 *
 *   • Zoho official NPX package (if published):
 *       ZOHO_MCP_CMD="npx" ZOHO_MCP_ARGS="-y,@zoho/projects-mcp-server"
 *
 *   • A locally installed binary:
 *       ZOHO_MCP_CMD="/usr/local/bin/zoho-projects-mcp"
 *
 *   • Claude Code's built-in zohoMcp connector (forward via claude mcp):
 *       Use the claude CLI to expose the connector as a named server, then
 *       point ZOHO_MCP_CMD at a wrapper script.
 *
 *   When ZOHO_MCP_CMD is unset the proxy falls back to the REST API path
 *   using ZOHO_ACCESS_TOKEN + ZOHO_PORTAL_NAME (legacy mode).
 *
 * ─── Endpoints ────────────────────────────────────────────────────────────
 *   GET /api/zoho/status                  → { mode, configured, portalName }
 *   GET /api/zoho/task/:taskId            → normalised task JSON
 *   GET /api/zoho/comments/:taskId/:pid   → comments array
 *
 *   Static files are served from this directory (open /user.html).
 */

'use strict';

const http  = require('http');
const https = require('https');
const url   = require('url');
const path  = require('path');
const fs    = require('fs');

const PORT         = process.env.PORT              || 3000;
const MCP_CMD      = process.env.ZOHO_MCP_CMD      || '';
const MCP_ARGS     = (process.env.ZOHO_MCP_ARGS    || '').split(',').filter(Boolean);
const PORTAL_NAME  = process.env.ZOHO_PORTAL_NAME  || 'hbegroupprojects';
const PROJECT_ID   = process.env.ZOHO_PROJECT_ID   || '';
// Legacy REST fallback
const ACCESS_TOKEN = process.env.ZOHO_ACCESS_TOKEN || '';

/* ── MIME map for static serving ─────────────────────────────── */
const MIME = {
  '.html':'text/html', '.css':'text/css', '.js':'application/javascript',
  '.json':'application/json', '.png':'image/png', '.jpg':'image/jpeg',
  '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.woff':'font/woff', '.woff2':'font/woff2', '.ttf':'font/ttf',
};

/* ══════════════════════════════════════════════════════════════
   MCP CLIENT  (spawns the Zoho MCP server as a stdio process)
══════════════════════════════════════════════════════════════ */
let mcpClient = null;
let mcpReady  = false;

async function initMcpClient() {
  if (!MCP_CMD) return false;
  try {
    const { Client }      = require('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

    const transport = new StdioClientTransport({
      command: MCP_CMD,
      args:    MCP_ARGS,
    });

    mcpClient = new Client({ name: 'evs-zoho-proxy', version: '1.0.0' }, { capabilities: {} });
    await mcpClient.connect(transport);
    mcpReady = true;
    console.log('[zoho-proxy] MCP client connected to:', MCP_CMD, MCP_ARGS.join(' '));

    // List available tools for diagnostics
    const { tools } = await mcpClient.listTools();
    console.log('[zoho-proxy] Available MCP tools:', tools.map(t => t.name).join(', '));
    return true;
  } catch (err) {
    console.warn('[zoho-proxy] MCP client init failed:', err.message);
    mcpReady = false;
    return false;
  }
}

async function mcpCallTool(name, args) {
  if (!mcpClient || !mcpReady) throw new Error('MCP client not ready');
  const result = await mcpClient.callTool({ name, arguments: args });
  // MCP tool results arrive as an array of content blocks
  const text = result.content?.find(c => c.type === 'text')?.text || '';
  try { return JSON.parse(text); }
  catch { return { raw: text }; }
}

/* ── Zoho tool name resolver ─────────────────────────────────── */
// The Zoho MCP server exposes tools named like:
//   ZohoProjects_get_task_details
//   ZohoProjects_get_tasks_by_project
//   ZohoProjects_get_tasks_by_portal
// We try each in order until one is found.
let _toolNames = null;
async function getToolNames() {
  if (_toolNames) return _toolNames;
  const { tools } = await mcpClient.listTools();
  _toolNames = new Set(tools.map(t => t.name));
  return _toolNames;
}

async function mcpFetchTask(taskId) {
  const tools = await getToolNames();

  // Prefer direct task-detail lookup
  const detailTool = [...tools].find(n => /get_task_details?$/i.test(n));
  if (detailTool) {
    const args = { task_id: taskId };
    if (PROJECT_ID) args.project_id = PROJECT_ID;
    args.portal_id = PORTAL_NAME;
    try {
      const data = await mcpCallTool(detailTool, args);
      if (data && (data.id || data.id_string || data.task)) return data;
    } catch { /* fall through to search */ }
  }

  // Fall back to portal-wide search
  const searchTool = [...tools].find(n => /get_tasks_by_portal$/i.test(n))
                  || [...tools].find(n => /get_tasks/i.test(n));
  if (searchTool) {
    const args = { portal_id: PORTAL_NAME, search_term: taskId };
    return mcpCallTool(searchTool, args);
  }

  throw new Error('No suitable Zoho MCP tool found for task lookup');
}

async function mcpFetchComments(taskId, projectId) {
  const tools = await getToolNames();
  const commentTool = [...tools].find(n => /get_task_comments?$/i.test(n));
  if (!commentTool) return { comments: [] };
  const args = { task_id: taskId, portal_id: PORTAL_NAME };
  if (projectId || PROJECT_ID) args.project_id = projectId || PROJECT_ID;
  try { return await mcpCallTool(commentTool, args); }
  catch { return { comments: [] }; }
}

/* ══════════════════════════════════════════════════════════════
   LEGACY REST FALLBACK  (used when ZOHO_MCP_CMD is not set)
══════════════════════════════════════════════════════════════ */
function restGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'projectsapi.zoho.com',
      path:     `/restapi${apiPath}`,
      headers:  { 'Authorization': `Zoho-oauthtoken ${ACCESS_TOKEN}` },
    }, res => {
      let body = '';
      res.on('data', d => { body += d; });
      res.on('end', () => {
        if (res.statusCode === 401) { reject({ status: 401, message: 'Zoho access token invalid or expired.' }); return; }
        if (res.statusCode === 403) { reject({ status: 403, message: 'Zoho access denied — check token scopes.' }); return; }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject({ status: res.statusCode, message: `Zoho API ${res.statusCode}: ${body.slice(0,200)}` }); return;
        }
        try { resolve(JSON.parse(body)); } catch { reject({ status:500, message:'Invalid JSON from Zoho' }); }
      });
    });
    req.on('error', e => reject({ status:502, message:`Network error: ${e.message}` }));
    req.end();
  });
}

async function restFetchTask(taskId) {
  if (PROJECT_ID) {
    try {
      return await restGet(`/portal/${enc(PORTAL_NAME)}/projects/${enc(PROJECT_ID)}/tasks/${enc(taskId)}/`);
    } catch (e) { if (e.status !== 404) throw e; }
  }
  return restGet(`/portal/${enc(PORTAL_NAME)}/tasks/?search_term=${enc(taskId)}`);
}

async function restFetchComments(taskId, projectId) {
  const pid = projectId || PROJECT_ID;
  if (!pid) return { comments: [] };
  try { return await restGet(`/portal/${enc(PORTAL_NAME)}/projects/${enc(pid)}/tasks/${enc(taskId)}/comments/`); }
  catch { return { comments: [] }; }
}

const enc = encodeURIComponent;

/* ══════════════════════════════════════════════════════════════
   UNIFIED FETCH  (MCP first, REST fallback)
══════════════════════════════════════════════════════════════ */
async function fetchTask(taskId) {
  if (mcpReady) return mcpFetchTask(taskId);
  if (ACCESS_TOKEN) return restFetchTask(taskId);
  throw new Error('No Zoho connection. Start server with ZOHO_MCP_CMD or ZOHO_ACCESS_TOKEN.');
}

async function fetchComments(taskId, projectId) {
  if (mcpReady) return mcpFetchComments(taskId, projectId);
  if (ACCESS_TOKEN) return restFetchComments(taskId, projectId);
  return { comments: [] };
}

/* ══════════════════════════════════════════════════════════════
   HTTP SERVER
══════════════════════════════════════════════════════════════ */
const server = http.createServer(async (req, res) => {
  const { pathname } = url.parse(req.url);

  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  /* /api/zoho/status */
  if (pathname === '/api/zoho/status') {
    sendJSON(res, 200, {
      mode:       mcpReady ? 'mcp' : (ACCESS_TOKEN ? 'rest' : 'unconfigured'),
      configured: mcpReady || !!ACCESS_TOKEN,
      portalName: PORTAL_NAME,
      hasProject: !!PROJECT_ID,
      mcpCmd:     MCP_CMD || null,
    });
    return;
  }

  /* /api/zoho/task/:taskId */
  if (pathname.startsWith('/api/zoho/task/')) {
    const taskId = decodeURIComponent(pathname.slice('/api/zoho/task/'.length));
    if (!taskId) { sendJSON(res, 400, { error: 'Task ID required' }); return; }
    if (!mcpReady && !ACCESS_TOKEN) {
      sendJSON(res, 503, { error: 'Zoho not configured. Set ZOHO_MCP_CMD or ZOHO_ACCESS_TOKEN.' });
      return;
    }
    try   { sendJSON(res, 200, await fetchTask(taskId)); }
    catch (e) { sendJSON(res, e.status || 500, { error: e.message || String(e) }); }
    return;
  }

  /* /api/zoho/comments/:taskId/:projectId? */
  if (pathname.startsWith('/api/zoho/comments/')) {
    const parts = pathname.slice('/api/zoho/comments/'.length).split('/');
    const taskId = decodeURIComponent(parts[0] || '');
    const pid    = decodeURIComponent(parts[1] || '');
    if (!taskId) { sendJSON(res, 400, { error: 'Task ID required' }); return; }
    try   { sendJSON(res, 200, await fetchComments(taskId, pid)); }
    catch (e) { sendJSON(res, e.status || 500, { error: e.message || String(e) }); }
    return;
  }

  /* Static files */
  let filePath = pathname === '/' ? '/user.html' : pathname;
  filePath = path.join(__dirname, filePath);
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not Found'); return; }
    const mime = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    fs.createReadStream(filePath).pipe(res);
  });
});

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/* ── Boot ────────────────────────────────────────────────────── */
(async () => {
  const mode = MCP_CMD ? 'MCP' : (ACCESS_TOKEN ? 'REST (legacy)' : 'UNCONFIGURED');
  console.log(`[zoho-proxy] Starting in ${mode} mode`);

  if (MCP_CMD) {
    const ok = await initMcpClient();
    if (!ok) console.warn('[zoho-proxy] MCP failed — falling back to REST if ZOHO_ACCESS_TOKEN is set');
  } else if (!ACCESS_TOKEN) {
    console.warn('[zoho-proxy] No ZOHO_MCP_CMD or ZOHO_ACCESS_TOKEN set. Task search will fail.');
    console.warn('[zoho-proxy] Set ZOHO_MCP_CMD to the Zoho MCP server command, e.g.:');
    console.warn('[zoho-proxy]   ZOHO_MCP_CMD=npx ZOHO_MCP_ARGS=-y,@zoho/projects-mcp-server node server.js');
  }

  server.listen(PORT, () => {
    console.log(`[zoho-proxy] Listening on http://localhost:${PORT}`);
    console.log(`[zoho-proxy] Portal : ${PORTAL_NAME}${PROJECT_ID ? ` | Project: ${PROJECT_ID}` : ''}`);
    console.log(`[zoho-proxy] Open   : http://localhost:${PORT}/user.html`);
  });
})();
