/**
 * auth.js — Authentication via Supabase Auth + profiles table
 * Employee Expense Verification System
 */

const Auth = (() => {

  const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes
  let _inactivityTimer = null;
  let _profile = null; // cached profile {id, username, display_name, role}

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

  function sb() { return getSupabase(); }

  /* ── Login with username + password ────────────────────── */
  async function login(username, password, remember = false) {
    // Look up email from profiles table by username
    const { data: prof, error: profErr } = await sb()
      .from('profiles')
      .select('email, role, display_name, username')
      .eq('username', username.trim())
      .maybeSingle();

    if (profErr) throw new Error('Profile lookup failed: ' + profErr.message);
    if (!prof)   throw new Error('User not found. Check username spelling or contact admin.');

    const { data, error } = await sb().auth.signInWithPassword({
      email:    prof.email,
      password: password,
    });
    if (error) throw new Error('Auth error: ' + error.message + ' [' + error.status + ']');

    _profile = { ...prof, id: data.user.id };

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
    await sb().auth.signOut();
    clearInactivityTimer();
    const q = reason ? `?reason=${encodeURIComponent(reason)}` : '';
    window.location.href = `login.html${q}`;
  }

  /* ── Get current Supabase session ───────────────────────── */
  async function getSessionAsync() {
    const { data: { session } } = await sb().auth.getSession();
    return session;
  }

  /* ── Get current profile (cached) ──────────────────────── */
  async function fetchProfile() {
    if (_profile) return _profile;
    const { data: { user } } = await sb().auth.getUser();
    if (!user) return null;
    const { data: prof } = await sb()
      .from('profiles')
      .select('username, display_name, role, email')
      .eq('id', user.id)
      .maybeSingle();
    if (!prof) return null;
    _profile = { ...prof, id: user.id };
    return _profile;
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
    const session = await getSessionAsync();
    if (!session) {
      window.location.href = 'login.html?reason=session_expired';
      return false;
    }
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
    const session = await getSessionAsync();
    if (session) {
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

  /* ── Update profile ─────────────────────────────────────── */
  async function updateSessionUser(data) {
    if (!_profile) return;
    const { error } = await sb().from('profiles').update(data).eq('id', _profile.id);
    if (error) throw new Error(error.message);
    _profile = { ..._profile, ...data };
  }

  /* ── Admin: create user ─────────────────────────────────── */
  // Login is by username, so email is only an internal identifier Supabase Auth
  // requires — synthesize one instead of asking the admin to supply a real address.
  async function adminCreateUser({ username, password, role, displayName }) {
    // Create auth user via Supabase Admin (requires service role in a backend)
    // For client-side: use sign-up then update profile
    const email = `${username}@expenseverify.com`;
    const { data, error } = await sb().auth.signUp({ email, password });
    if (error) throw new Error(error.message);
    const uid = data.user?.id;
    if (!uid) throw new Error('User creation failed.');
    const { error: profErr } = await sb().from('profiles').upsert({
      id: uid, username, email, display_name: displayName, role,
    });
    if (profErr) throw new Error(profErr.message);
    return uid;
  }

  /* ── Admin: list all users ──────────────────────────────── */
  async function getAllUsers() {
    const { data, error } = await sb().from('profiles').select('*').order('username');
    if (error) throw new Error(error.message);
    return data || [];
  }

  /* ── Admin: delete user ─────────────────────────────────── */
  async function adminDeleteUser(userId) {
    const { error } = await sb().from('profiles').delete().eq('id', userId);
    if (error) throw new Error(error.message);
  }

  /* ── Admin: update user role / display name ─────────────── */
  async function adminUpdateUser(userId, updates) {
    const { error } = await sb().from('profiles').update(updates).eq('id', userId);
    if (error) throw new Error(error.message);
  }

  /* ── Change password ────────────────────────────────────── */
  async function changePassword(newPassword) {
    const { error } = await sb().auth.updateUser({ password: newPassword });
    if (error) throw new Error(error.message);
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
