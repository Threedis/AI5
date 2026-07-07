/**
 * auth.js — Authentication via Cloudflare D1 + Pages Functions (cookie sessions)
 * Employee Expense Verification System
 */

const Auth = (() => {

  const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes
  let _inactivityTimer = null;
  let _profile = null; // cached profile {id, username, display_name, role, ...}

  /* ── Role definitions ───────────────────────────────────── */
  const ROLES = {
    admin:    { label: 'Administrator', color: 'purple', icon: 'fa-shield-halved' },
    hr:       { label: 'HR',            color: 'blue',   icon: 'fa-users' },
    accounts: { label: 'Accounts',      color: 'teal',   icon: 'fa-calculator' },
    user:     { label: 'User',          color: 'green',  icon: 'fa-user' }
  };

  /* ── Route access map ───────────────────────────────────── */
  const ROUTE_ACCESS = {
    'dashboard.html': ['admin', 'hr', 'accounts', 'user'],
    'admin.html':     ['admin'],
    'hr.html':        ['admin', 'hr'],
    'accounts.html':  ['admin', 'accounts'],
    'user.html':      ['admin', 'hr', 'accounts', 'user']
  };

  async function apiFetch(path, opts = {}) {
    const res = await fetch(path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...opts,
    });
    let body = null;
    try { body = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
    return body;
  }

  /* ── Login with username + password ────────────────────── */
  async function login(username, password, remember = false) {
    const { profile } = await apiFetch('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: username.trim(), password }),
    });
    _profile = profile;

    if (remember) {
      localStorage.setItem('evs_remember', username.trim());
    }
    return _profile;
  }

  /* ── Logout ─────────────────────────────────────────────── */
  async function logout(reason = '') {
    try {
      await Audit.log({ module: 'Auth', action: 'Logout', status: 'success', detail: reason || 'User logged out' });
    } catch {}
    _profile = null;
    try { await apiFetch('/api/auth/logout', { method: 'POST' }); } catch {}
    clearInactivityTimer();
    const q = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    window.location.href = `login.html${q}`;
  }

  /* ── Get current session's profile (also refreshes the cache) ── */
  async function getSessionAsync() {
    try {
      const { profile } = await apiFetch('/api/auth/session');
      _profile = profile;
      return profile;
    } catch {
      return null;
    }
  }

  /* ── Get current profile (cached) ──────────────────────── */
  async function fetchProfile() {
    if (_profile) return _profile;
    return getSessionAsync();
  }

  /* ── Synchronous current user (from cache) ──────────────── */
  function getCurrentUser() {
    return _profile;
  }

  /* ── Is logged in (sync check via cached profile) ───────── */
  function isLoggedIn() {
    return !!_profile;
  }

  /* ── requireAuth — call at top of each protected page ───── */
  async function requireAuth(allowedRoles = null) {
    const profile = await fetchProfile();
    if (!profile) {
      window.location.href = 'login.html?reason=session_expired';
      return false;
    }
    if (allowedRoles && !allowedRoles.includes(profile.role)) {
      window.location.href = 'dashboard.html?reason=unauthorized';
      return false;
    }
    return true;
  }

  /* ── requireGuest — call on login page ──────────────────── */
  async function requireGuest() {
    const profile = await getSessionAsync();
    if (profile) {
      window.location.href = 'dashboard.html';
      return false;
    }
    return true;
  }

  /* ── Role helpers ───────────────────────────────────────── */
  function hasRole(role) {
    if (!_profile) return false;
    return Array.isArray(role) ? role.includes(_profile.role) : _profile.role === role;
  }

  function canAccessPage(page) {
    if (!_profile) return false;
    return (ROUTE_ACCESS[page] || []).includes(_profile.role);
  }

  function getRoleInfo(role) {
    return ROLES[role] || { label: role, color: 'gray', icon: 'fa-user' };
  }

  function getAllRoles() {
    return Object.entries(ROLES).map(([key, val]) => ({ key, ...val }));
  }

  /* ── Inactivity timer ───────────────────────────────────── */
  function resetInactivityTimer() {
    clearInactivityTimer();
    _inactivityTimer = setTimeout(async () => {
      if (await getSessionAsync()) await logout('inactivity');
    }, INACTIVITY_MS);
  }

  function clearInactivityTimer() {
    if (_inactivityTimer) { clearTimeout(_inactivityTimer); _inactivityTimer = null; }
  }

  function startInactivityWatch() {
    const reset = Utils.throttle(resetInactivityTimer, 30000);
    ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(evt => {
      document.addEventListener(evt, reset, { passive: true });
    });
    resetInactivityTimer();
  }

  /* ── Remember username ──────────────────────────────────── */
  function getRememberedUsername() {
    return localStorage.getItem('evs_remember') || '';
  }

  /* ── Update own profile (display name / department only — role/status stay admin-only) ── */
  async function updateSessionUser(data) {
    if (!_profile) return;
    await apiFetch('/api/auth/profile', { method: 'PATCH', body: JSON.stringify(data) });
    _profile = { ..._profile, ...data };
  }

  /* ── Admin: create user ─────────────────────────────────── */
  // Login is by username; there's no real-email requirement at all anymore —
  // Auth is now our own D1-backed users table, not Supabase.
  async function adminCreateUser({ username, password, role, displayName, department, status }) {
    const { id } = await apiFetch('/api/auth/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, role, displayName, department, status }),
    });
    return id;
  }

  /* ── Admin: list all users ──────────────────────────────── */
  async function getAllUsers() {
    const { users } = await apiFetch('/api/auth/users');
    return (users || []).slice().sort((a, b) => a.username.localeCompare(b.username));
  }

  /* ── Admin: delete user ─────────────────────────────────── */
  async function adminDeleteUser(userId) {
    await apiFetch(`/api/auth/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  /* ── Admin: update user role / display name / password ──── */
  async function adminUpdateUser(userId, updates) {
    await apiFetch(`/api/auth/users/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify(updates) });
  }

  /* ── Change own password ────────────────────────────────── */
  async function changePassword(newPassword) {
    await apiFetch('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ newPassword }) });
  }

  return {
    ROLES, ROUTE_ACCESS,
    login, logout,
    getSessionAsync, fetchProfile,
    getCurrentUser, isLoggedIn, hasRole, canAccessPage,
    requireAuth, requireGuest,
    startInactivityWatch, resetInactivityTimer,
    getRememberedUsername,
    getRoleInfo, getAllRoles,
    updateSessionUser,
    adminCreateUser, getAllUsers, adminDeleteUser, adminUpdateUser,
    changePassword,
  };
})();
