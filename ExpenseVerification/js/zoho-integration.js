/**
 * zoho-integration.js — Zoho Projects REST API client
 * Fetches task details by Task ID, extracts approval info and summary provider.
 * Config (portal ID, project ID, access token) stored in localStorage.
 */

const ZohoProjects = (() => {

  const CONFIG_KEY = 'evs_zoho_config';

  /* ── Config helpers ──────────────────────────────────────── */
  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}'); }
    catch { return {}; }
  }

  function saveConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...getConfig(), ...cfg }));
  }

  function isConfigured() {
    const c = getConfig();
    return !!(c.accessToken && c.portalId);
  }

  /* ── Approval status derivation ──────────────────────────── */
  function deriveApprovalStatus(task) {
    const s = (task.status?.name || task.status || '').toLowerCase();
    if (/complet|done|approv|clear|paid/i.test(s))  return 'approved';
    if (/reject|denied|cancel|revert/i.test(s))     return 'rejected';
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

    const empIds = extractEmpIds(task);
    const approvers = extractApprovers(task);

    // "Summary provider" = person who created/submitted the task
    const summaryProvider = task.created_by?.display_name || task.created_by || '';

    // Custom fields as key-value map for display
    const customMap = {};
    (task.custom_fields || []).forEach(cf => {
      const label = cf.column_name || cf.label_name || cf.field_id || '';
      if (label && cf.value != null) customMap[label] = String(cf.value);
    });

    return {
      taskId:          task.id_string || task.id || taskId,
      taskName:        task.name || '',
      projectName:     task.project?.name || '',
      status:          task.status?.name || task.status || '',
      approvalStatus:  deriveApprovalStatus(task),
      createdBy:       summaryProvider,
      summaryProvider,
      approvers,
      empIds,
      assignees:       (task.details?.owners || []).map(o => o.display_name || '').filter(Boolean),
      description:     task.description || '',
      createdAt:       task.created_time_string || task.created_time || '',
      dueDate:         task.end_date_string || task.end_date || '',
      isCompleted:     !!task.completed,
      customFields:    customMap,
      _raw:            task,
    };
  }

  /* ── Call Zoho Projects REST API ─────────────────────────── */
  async function fetchTask(taskId) {
    const cfg = getConfig();
    if (!cfg.accessToken) throw new Error('Zoho access token not set. Open ⚙ Zoho Settings below.');
    if (!cfg.portalId)    throw new Error('Zoho portal ID not set. Open ⚙ Zoho Settings below.');

    const headers = {
      'Authorization': `Zoho-oauthtoken ${cfg.accessToken}`,
    };

    // If projectId is known, hit the direct endpoint; otherwise search across the portal.
    let url;
    if (cfg.projectId) {
      url = `https://projectsapi.zoho.com/restapi/portal/${encodeURIComponent(cfg.portalId)}/projects/${encodeURIComponent(cfg.projectId)}/tasks/${encodeURIComponent(taskId)}/`;
    } else {
      // Search by task ID string across portal
      url = `https://projectsapi.zoho.com/restapi/portal/${encodeURIComponent(cfg.portalId)}/tasks/?search_term=${encodeURIComponent(taskId)}`;
    }

    let res;
    try {
      res = await fetch(url, { headers });
    } catch (netErr) {
      throw new Error(`Network error reaching Zoho API: ${netErr.message}`);
    }

    if (res.status === 401) throw new Error('Zoho access token is invalid or expired.');
    if (res.status === 403) throw new Error('Zoho access denied — check token scopes (ZohoProjects.tasks.READ).');
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Zoho API error ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    return parseTask(data, taskId);
  }

  /* ── Fetch comments for a task (to find summary submitter) ─ */
  async function fetchTaskComments(taskId, projectId) {
    const cfg = getConfig();
    if (!cfg.accessToken || !cfg.portalId) return [];
    const pid = projectId || cfg.projectId;
    if (!pid) return [];

    const url = `https://projectsapi.zoho.com/restapi/portal/${encodeURIComponent(cfg.portalId)}/projects/${encodeURIComponent(pid)}/tasks/${encodeURIComponent(taskId)}/comments/`;
    try {
      const res = await fetch(url, { headers: { 'Authorization': `Zoho-oauthtoken ${cfg.accessToken}` } });
      if (!res.ok) return [];
      const data = await res.json();
      return (data.comments || []).map(c => ({
        author:    c.added_by?.display_name || c.added_by || '',
        content:   c.content || '',
        createdAt: c.time_long || c.added_time_string || '',
      }));
    } catch { return []; }
  }

  /* ── Build a human-readable summary string ───────────────── */
  function getSummary(parsed) {
    const parts = [];
    if (parsed.approvalStatus !== 'unknown') parts.push(`Status: ${Utils.titleCase(parsed.approvalStatus)}`);
    if (parsed.taskName)       parts.push(`Task: ${parsed.taskName}`);
    if (parsed.projectName)    parts.push(`Project: ${parsed.projectName}`);
    if (parsed.summaryProvider) parts.push(`Submitted by: ${parsed.summaryProvider}`);
    if (parsed.approvers.length) parts.push(`Approver: ${parsed.approvers[0]}`);
    if (parsed.empIds.length)  parts.push(`${parsed.empIds.length} emp ID(s) found`);
    return parts.join(' · ') || 'Task fetched — no structured data detected';
  }

  return {
    getConfig,
    saveConfig,
    isConfigured,
    fetchTask,
    fetchTaskComments,
    getSummary,
    parseTask,
  };

})();
