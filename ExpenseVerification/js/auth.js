/**
 * auth.js — Authentication, session management, role-based access
 * Employee Expense Verification System
 */

const Auth = (() => {

  const SESSION_KEY   = 'evs_session';
  const REMEMBER_KEY  = 'evs_remember';
  const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes

  let _inactivityTimer = null;

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

  /* ── Get current session ────────────────────────────────── */
  function getSession() {
    const raw = sessionStorage.getItem(SESSION_KEY)
              || localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    try {
      const sess = JSON.parse(raw);
      if (sess.expires && Date.now() > sess.expires) {
        clearSession();
        return null;
      }
      return sess;
    } catch { return null; }
  }

  /* ── Save session ───────────────────────────────────────── */
  function saveSession(user, remember = false) {
    const sess = {
      ...user,
      loginAt: Date.now(),
      expires: remember ? Date.now() + (7 * 24 * 60 * 60 * 1000) : null
    };
    const store = remember ? localStorage : sessionStorage;
    store.setItem(SESSION_KEY, JSON.stringify(sess));
    if (remember) localStorage.setItem(REMEMBER_KEY, user.username);
  }

  /* ── Clear session ──────────────────────────────────────── */
  function clearSession() {
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
    clearInactivityTimer();
  }

  /* ── Check if logged in ─────────────────────────────────── */
  function isLoggedIn() {
    return getSession() !== null;
  }

  /* ── Get current user ───────────────────────────────────── */
  function getCurrentUser() {
    return getSession();
  }

  /* ── Has role ───────────────────────────────────────────── */
  function hasRole(role) {
    const sess = getSession();
    if (!sess) return false;
    if (Array.isArray(role)) return role.includes(sess.role);
    return sess.role === role;
  }

  /* ── Can access current page ────────────────────────────── */
  function canAccessPage(page) {
    const sess = getSession();
    if (!sess) return false;
    const allowed = ROUTE_ACCESS[page] || [];
    return allowed.includes(sess.role);
  }

  /* ── Guard: redirect to login if not authenticated ──────── */
  function requireAuth(allowedRoles = null) {
    if (!isLoggedIn()) {
      window.location.href = 'login.html';
      return false;
    }
    const sess = getSession();
    if (allowedRoles && !allowedRoles.includes(sess.role)) {
      window.location.href = 'dashboard.html';
      return false;
    }
    return true;
  }

  /* ── Guard: redirect to dashboard if already logged in ─── */
  function requireGuest() {
    if (isLoggedIn()) {
      window.location.href = 'dashboard.html';
      return false;
    }
    return true;
  }

  /* ── Inactivity auto-logout ─────────────────────────────── */
  function resetInactivityTimer() {
    clearInactivityTimer();
    _inactivityTimer = setTimeout(() => {
      const sess = getSession();
      if (sess) {
        clearSession();
        window.location.href = `login.html?reason=inactivity`;
      }
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

  /* ── Logout ─────────────────────────────────────────────── */
  function logout(reason = '') {
    const sess = getSession();
    if (sess) {
      Audit.log({
        module: 'Auth',
        action: 'Logout',
        status: 'success',
        detail: reason || 'User logged out'
      }).catch(() => {});
    }
    clearSession();
    const q = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    window.location.href = `login.html${q}`;
  }

  /* ── Get remembered username ────────────────────────────── */
  function getRememberedUsername() {
    return localStorage.getItem(REMEMBER_KEY) || '';
  }

  /* ── Role helpers ───────────────────────────────────────── */
  function getRoleInfo(role) {
    return ROLES[role] || { label: role, color: 'gray', icon: 'fa-user' };
  }

  function getAllRoles() {
    return Object.entries(ROLES).map(([key, val]) => ({ key, ...val }));
  }

  /* ── Update session user data ───────────────────────────── */
  function updateSessionUser(data) {
    const sess = getSession();
    if (!sess) return;
    const updated = { ...sess, ...data };
    const inLocal = !!localStorage.getItem(SESSION_KEY);
    const store   = inLocal ? localStorage : sessionStorage;
    store.setItem(SESSION_KEY, JSON.stringify(updated));
  }

  return {
    ROLES, ROUTE_ACCESS,
    getSession, saveSession, clearSession,
    isLoggedIn, getCurrentUser, hasRole, canAccessPage,
    requireAuth, requireGuest,
    startInactivityWatch, resetInactivityTimer,
    logout,
    getRememberedUsername, getRoleInfo, getAllRoles,
    updateSessionUser
  };
})();
