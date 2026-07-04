/**
 * zoho-integration.js — Zoho Projects client via local MCP proxy.
 *
 * All Zoho API calls go through the local Node.js proxy server (server.js),
 * which holds the OAuth access token in an environment variable.
 * The browser never handles Zoho credentials directly.
 *
 * Proxy endpoints (served by ExpenseVerification/server.js):
 *   GET /api/zoho/status              → { configured, portalId, hasProject }
 *   GET /api/zoho/task/:taskId        → raw Zoho task JSON
 *   GET /api/zoho/comments/:taskId/:projectId  → raw Zoho comments JSON
 */

const ZohoProjects = (() => {

  /* Proxy origin — same host when running via server.js, or override via
     localStorage key 'evs_zoho_proxy' for a remote deployment.           */
  function getProxyOrigin() {
    try { return localStorage.getItem('evs_zoho_proxy') || 'http://localhost:3000'; }
    catch { return 'http://localhost:3000'; }
  }

  let _serverStatus = null; // cached { configured, portalId, hasProject } | null

  /* ── Server connectivity check ──────────────────────────── */
  async function checkServer() {
    if (_serverStatus) return _serverStatus;
    try {
      const res = await fetch(`${getProxyOrigin()}/api/zoho/status`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      _serverStatus = await res.json();
    } catch {
      _serverStatus = { configured: false, portalId: null, hasProject: false, offline: true };
    }
    return _serverStatus;
  }

  function resetCache() { _serverStatus = null; }

  /* ── Approval status derivation ──────────────────────────── */
  function deriveApprovalStatus(task) {
    const s = (task.status?.name || task.status || '').toLowerCase();
    if (/complet|done|approv|clear|paid/i.test(s))   return 'approved';
    if (/reject|denied|cancel|revert/i.test(s))      return 'rejected';
    if (/pending|progress|review|open|new/i.test(s)) return 'pending';
    return 'unknown';
  }

  /* ── Extract approvers from task object ──────────────────── */
  function extractApprovers(task) {
    const names = new Set();
    (task.details?.owners || []).forEach(o => { if (o.display_name) names.add(o.display_name); });
    if (task.modified_by?.display_name) names.add(task.modified_by.display_name);
    (task.custom_fields || []).forEach(cf => {
      if (/approv|authoris|authoriz/i.test(cf.column_name || cf.label_name || '')) {
        if (cf.value) names.add(String(cf.value).trim());
      }
    });
    return [...names];
  }

  /* ── Extract employee IDs from task text ─────────────────── */
  function extractEmpIds(task) {
    const text = [
      task.name || '',
      task.description || '',
      ...(task.custom_fields || []).map(cf => String(cf.value || '')),
    ].join(' ');

    const patterns = [
      /\bEMP[-_/]?\d{3,8}\b/gi,
      /\bE[-_]?\d{4,8}\b/gi,
      /\bSTAFF[-_]?\d{3,8}\b/gi,
      /\bP[-_]?\d{4,8}\b/gi,
      /\b\d{4,8}\/\d{2,4}\b/g,
    ];
    const ids = new Set();
    for (const pat of patterns) {
      for (const m of text.matchAll(new RegExp(pat.source, pat.flags))) ids.add(m[0].toUpperCase());
    }
    return [...ids];
  }

  /* ── Parse a raw Zoho task object into our approval shape ── */
  function parseTask(raw, taskId) {
    const task = Array.isArray(raw.tasks) ? raw.tasks[0] : (raw.task || raw);
    if (!task || (!task.id && !task.id_string)) throw new Error(`Task ${taskId} not found in Zoho Projects.`);

    const empIds     = extractEmpIds(task);
    const approvers  = extractApprovers(task);
    const summaryProvider = task.created_by?.display_name || task.created_by || '';

    const customMap = {};
    (task.custom_fields || []).forEach(cf => {
      const label = cf.column_name || cf.label_name || cf.field_id || '';
      if (label && cf.value != null) customMap[label] = String(cf.value);
    });

    return {
      taskId:         task.id_string || task.id || taskId,
      taskName:       task.name || '',
      projectName:    task.project?.name || '',
      projectId:      task.project?.id_string || task.project?.id || '',
      status:         task.status?.name || task.status || '',
      approvalStatus: deriveApprovalStatus(task),
      createdBy:      summaryProvider,
      summaryProvider,
      approvers,
      empIds,
      assignees:      (task.details?.owners || []).map(o => o.display_name || '').filter(Boolean),
      description:    task.description || '',
      createdAt:      task.created_time_string || task.created_time || '',
      dueDate:        task.end_date_string || task.end_date || '',
      isCompleted:    !!task.completed,
      customFields:   customMap,
      _raw:           task,
    };
  }

  /* ── Fetch task via proxy ────────────────────────────────── */
  async function fetchTask(taskId) {
    const origin = getProxyOrigin();
    let res;
    try {
      res = await fetch(`${origin}/api/zoho/task/${encodeURIComponent(taskId)}`);
    } catch {
      throw new Error(
        'Cannot reach the Zoho proxy server. ' +
        `Start it with: ZOHO_ACCESS_TOKEN=<token> node server.js  (port 3000)`
      );
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const msg  = body.error || `Proxy error ${res.status}`;
      if (res.status === 503) throw new Error(`Proxy not configured: ${msg}`);
      throw new Error(msg);
    }

    const data = await res.json();
    return parseTask(data, taskId);
  }

  /* ── Fetch comments via proxy ────────────────────────────── */
  async function fetchTaskComments(taskId, projectId) {
    const origin = getProxyOrigin();
    const pid    = projectId || '';
    try {
      const res = await fetch(`${origin}/api/zoho/comments/${encodeURIComponent(taskId)}/${encodeURIComponent(pid)}`);
      if (!res.ok) return [];
      const data = await res.json();
      return (data.comments || []).map(c => ({
        author:    c.added_by?.display_name || c.added_by || '',
        content:   c.content || '',
        createdAt: c.time_long || c.added_time_string || '',
      }));
    } catch { return []; }
  }

  /* ── Mode label from last server status ─────────────────── */
  function getMode() {
    return _serverStatus?.mode || 'unknown';
  }

  /* ── Human-readable summary ──────────────────────────────── */
  function getSummary(parsed) {
    const parts = [];
    if (parsed.approvalStatus !== 'unknown') parts.push(`Status: ${Utils.titleCase(parsed.approvalStatus)}`);
    if (parsed.taskName)        parts.push(`Task: ${parsed.taskName}`);
    if (parsed.projectName)     parts.push(`Project: ${parsed.projectName}`);
    if (parsed.summaryProvider) parts.push(`Submitted by: ${parsed.summaryProvider}`);
    if (parsed.approvers.length) parts.push(`Approver: ${parsed.approvers[0]}`);
    if (parsed.empIds.length)   parts.push(`${parsed.empIds.length} emp ID(s) found`);
    return parts.join(' · ') || 'Task fetched — no structured data detected';
  }

  return {
    checkServer,
    resetCache,
    getMode,
    getProxyOrigin,
    fetchTask,
    fetchTaskComments,
    getSummary,
    parseTask,
  };

})();
