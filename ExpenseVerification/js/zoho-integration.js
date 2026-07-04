/**
 * zoho-integration.js — Direct Zoho Projects client using OAuth implicit flow.
 *
 * No proxy server required. The browser authenticates with Zoho via OAuth 2.0
 * implicit grant (response_type=token) and calls the Zoho Projects REST API
 * directly. The access token is stored in sessionStorage.
 *
 * Prerequisites (one-time setup by admin):
 *   1. Create a Zoho API Console app at https://api-console.zoho.com/
 *      - Client type: "JavaScript Client"
 *      - Authorised redirect URI: this page's URL
 *        (e.g. https://threedis.github.io/RCMS/ExpenseVerification/user.html)
 *   2. Enter the Client ID in the settings panel in the app.
 *      (Client Secret is NOT required for implicit flow.)
 *
 * Token lifecycle:
 *   - Stored in sessionStorage; clears on tab/browser close.
 *   - Zoho implicit tokens expire in 1 hour; the UI prompts reconnect on expiry.
 */

const ZohoProjects = (() => {

  const API_BASE      = 'https://expense.ajaywilllisten.workers.dev/restapi';
  const ACCOUNTS_URL  = 'https://accounts.zoho.com/oauth/v2/auth';
  const PORTAL_NAME   = 'hbegroupprojects';
  const SCOPE         = 'ZohoProjects.portals.READ,ZohoProjects.tasks.READ,' +
                        'ZohoProjects.tasklists.READ,ZohoProjects.projects.READ,' +
                        'ZohoProjects.comments.READ';
  const TOKEN_KEY     = 'zoho_token';
  const CLIENT_ID_KEY = 'zoho_client_id';

  function getClientId()   { return localStorage.getItem(CLIENT_ID_KEY) || ''; }
  function setClientId(id) { localStorage.setItem(CLIENT_ID_KEY, id.trim()); }
  function clearClientId() { localStorage.removeItem(CLIENT_ID_KEY); }

  function getToken() {
    try {
      const raw = sessionStorage.getItem(TOKEN_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      if (Date.now() >= d.expiresAt) { sessionStorage.removeItem(TOKEN_KEY); return null; }
      return d.token;
    } catch { return null; }
  }

  function storeToken(token, expiresIn) {
    sessionStorage.setItem(TOKEN_KEY, JSON.stringify({
      token,
      expiresAt: Date.now() + (parseInt(expiresIn, 10) - 60) * 1000,
    }));
  }

  function clearToken() { sessionStorage.removeItem(TOKEN_KEY); }
  function isConnected() { return !!getToken(); }

  function handleOAuthCallback() {
    if (!location.hash) return false;
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token     = params.get('access_token');
    const expiresIn = params.get('expires_in') || '3600';
    if (!token) return false;
    storeToken(token, expiresIn);
    history.replaceState(null, '', location.pathname + location.search);
    return true;
  }

  function connect() {
    const clientId = getClientId();
    if (!clientId) throw new Error('Enter your Zoho Client ID first.');
    const redirectUri = location.href.split('#')[0].split('?')[0];
    const params = new URLSearchParams({
      response_type: 'token',
      client_id:     clientId,
      scope:         SCOPE,
      redirect_uri:  redirectUri,
      prompt:        'consent',
      access_type:   'online',
    });
    location.href = `${ACCOUNTS_URL}?${params}`;
  }

  function disconnect() { clearToken(); }

  async function apiGet(path) {
    const token = getToken();
    if (!token) throw new Error('Not connected. Click "Connect to Zoho" to authenticate.');
    const res = await fetch(`${API_BASE}${path}`, {
      headers: { 'Authorization': `Zoho-oauthtoken ${token}` },
    });
    if (res.status === 401) {
      clearToken();
      throw new Error('Zoho session expired. Click "Connect to Zoho" to reconnect.');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error?.message || body.message || `Zoho API error ${res.status}`);
    }
    return res.json();
  }

  function deriveApprovalStatus(task) {
    const s = (task.status?.name || task.status || '').toLowerCase();
    if (/complet|done|approv|clear|paid/i.test(s))   return 'approved';
    if (/reject|denied|cancel|revert/i.test(s))      return 'rejected';
    if (/pending|progress|review|open|new/i.test(s)) return 'pending';
    return 'unknown';
  }

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

  function parseTask(raw, taskId) {
    const task = Array.isArray(raw.tasks) ? raw.tasks[0] : (raw.task || raw);
    if (!task || (!task.id && !task.id_string)) throw new Error(`Task ${taskId} not found in Zoho Projects.`);

    const empIds    = extractEmpIds(task);
    const approvers = extractApprovers(task);
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

  async function resolveDisplayId(displayId) {
    const m = displayId.match(/^([A-Za-z0-9]+)-[Tt](\d+)$/);
    if (!m) return null;
    const prefix = m[1].toUpperCase();
    const seq    = parseInt(m[2], 10);

    const projData = await apiGet(`/portal/${enc(PORTAL_NAME)}/projects/`);
    const projects = projData.projects || [];

    const project = projects.find(p => {
      const candidates = [p.key, p.prefix, p.id_string, p.name].filter(Boolean);
      return candidates.some(v => v.toString().toUpperCase() === prefix);
    });
    if (!project) {
      const available = projects.map(p => p.prefix || p.key || p.name || p.id_string).filter(Boolean).join(', ');
      throw new Error(`No project found with prefix "${prefix}". Available: ${available || 'none'}`);
    }

    const projectId = project.id_string || project.id;

    const taskData = await apiGet(
      `/portal/${enc(PORTAL_NAME)}/projects/${enc(projectId)}/tasks/?range=100`
    );
    const tasks = taskData.tasks || [];

    const task = tasks.find(t =>
      (t.key || '').toUpperCase()      === `${prefix}-T${seq}` ||
      (t.task_key || '').toUpperCase() === `${prefix}-T${seq}` ||
      parseInt(t.sequence_num || t.task_index || 0, 10) === seq
    );
    if (!task) throw new Error(`Task ${displayId} not found in project "${project.name}".`);

    return { task, projectId };
  }

  async function fetchTask(taskId) {
    const input = taskId.trim();

    if (/^[A-Za-z0-9]+-[Tt]\d+$/.test(input)) {
      const resolved = await resolveDisplayId(input);
      if (resolved) {
        const { task, projectId } = resolved;
        if (!task.project) task.project = { id_string: projectId };
        return parseTask({ tasks: [task] }, input);
      }
    }

    const data = await apiGet(`/portal/${enc(PORTAL_NAME)}/tasks/?search_term=${enc(input)}`);
    return parseTask(data, input);
  }

  async function fetchTaskComments(taskId, projectId) {
    if (!projectId) return [];
    try {
      const data = await apiGet(`/portal/${enc(PORTAL_NAME)}/projects/${enc(projectId)}/tasks/${enc(taskId)}/comments/`);
      return (data.comments || []).map(c => ({
        author:    c.added_by?.display_name || c.added_by || '',
        content:   c.content || '',
        createdAt: c.time_long || c.added_time_string || '',
      }));
    } catch { return []; }
  }

  const enc = encodeURIComponent;

  function getSummary(parsed) {
    const parts = [];
    if (parsed.approvalStatus !== 'unknown') parts.push(`Status: ${Utils.titleCase(parsed.approvalStatus)}`);
    if (parsed.taskName)         parts.push(`Task: ${parsed.taskName}`);
    if (parsed.projectName)      parts.push(`Project: ${parsed.projectName}`);
    if (parsed.summaryProvider)  parts.push(`Submitted by: ${parsed.summaryProvider}`);
    if (parsed.approvers.length) parts.push(`Approver: ${parsed.approvers[0]}`);
    if (parsed.empIds.length)    parts.push(`${parsed.empIds.length} emp ID(s) found`);
    return parts.join(' · ') || 'Task fetched — no structured data detected';
  }

  return {
    handleOAuthCallback,
    connect,
    disconnect,
    isConnected,
    getClientId,
    setClientId,
    clearClientId,
    fetchTask,
    fetchTaskComments,
    getSummary,
    parseTask,
  };

})();
