/**
 * app.js — Application bootstrap, UI orchestration, toast/modal system
 * Employee Expense Verification System
 */

const App = (() => {

  /* ── Toast Notification System ──────────────────────────── */
  const Toast = (() => {
    let container;

    function getContainer() {
      if (!container) {
        container = document.createElement('div');
        container.className = 'toast-container';
        document.body.appendChild(container);
      }
      return container;
    }

    const ICONS = {
      success: 'fa-circle-check',
      error:   'fa-circle-xmark',
      warning: 'fa-triangle-exclamation',
      info:    'fa-circle-info'
    };

    function show({ type = 'info', title = '', message = '', duration = 4000 }) {
      const c    = getContainer();
      const icon = ICONS[type] || ICONS.info;
      const el   = document.createElement('div');
      el.className = `toast ${type}`;
      el.innerHTML = `
        <i class="toast-icon fa-solid ${icon}"></i>
        <div class="toast-body">
          ${title   ? `<div class="toast-title">${Utils.escapeHtml(title)}</div>` : ''}
          ${message ? `<div class="toast-msg">${Utils.escapeHtml(message)}</div>` : ''}
        </div>
        <button class="toast-close" aria-label="Close">
          <i class="fa-solid fa-xmark"></i>
        </button>`;
      el.querySelector('.toast-close').addEventListener('click', () => remove(el));
      c.appendChild(el);
      if (duration > 0) setTimeout(() => remove(el), duration);
      return el;
    }

    function remove(el) {
      if (!el || !el.parentNode) return;
      el.style.animation = 'none';
      el.style.opacity   = '0';
      el.style.transform = 'translateX(24px)';
      el.style.transition = 'opacity .25s, transform .25s';
      setTimeout(() => el.remove(), 260);
    }

    const success = (title, message, duration) => show({ type: 'success', title, message, duration });
    const error   = (title, message, duration) => show({ type: 'error',   title, message, duration });
    const warning = (title, message, duration) => show({ type: 'warning', title, message, duration });
    const info    = (title, message, duration) => show({ type: 'info',    title, message, duration });

    return { show, success, error, warning, info };
  })();

  /* ── Loading Overlay ────────────────────────────────────── */
  const Loader = (() => {
    let overlay;

    function show(msg = 'Please wait…') {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'loading-overlay';
        document.body.appendChild(overlay);
      }
      overlay.innerHTML = `
        <div class="spinner"></div>
        <p>${Utils.escapeHtml(msg)}</p>`;
      overlay.style.display = 'flex';
    }

    function hide() {
      if (overlay) overlay.style.display = 'none';
    }

    function update(msg) {
      if (overlay) {
        const p = overlay.querySelector('p');
        if (p) p.textContent = msg;
      }
    }

    return { show, hide, update };
  })();

  /* ── Modal System ───────────────────────────────────────── */
  const Modal = (() => {

    function create({ title = '', body = '', footer = '', size = '', onClose }) {
      const backdrop = document.createElement('div');
      backdrop.className = 'modal-backdrop';

      const sizeClass = size ? ` modal-${size}` : '';
      backdrop.innerHTML = `
        <div class="modal${sizeClass}" role="dialog" aria-modal="true">
          <div class="modal-header">
            <span class="modal-title">${Utils.escapeHtml(title)}</span>
            <button class="btn-icon btn-ghost modal-close-btn" aria-label="Close">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <div class="modal-body">${body}</div>
          ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
        </div>`;

      const close = () => {
        backdrop.style.animation = 'none';
        backdrop.style.opacity   = '0';
        backdrop.style.transition = 'opacity .2s';
        setTimeout(() => { backdrop.remove(); onClose?.(); }, 210);
      };

      backdrop.querySelector('.modal-close-btn').addEventListener('click', close);
      backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
      document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
      }, { once: true });

      document.body.appendChild(backdrop);
      return { el: backdrop, close };
    }

    function confirm({ title = 'Confirm', message = '', confirmText = 'Confirm',
                       confirmClass = 'btn-danger', cancelText = 'Cancel' }) {
      return new Promise(resolve => {
        const { el, close } = create({
          title,
          body: `<p style="color:var(--text-secondary);line-height:1.6;">${Utils.escapeHtml(message)}</p>`,
          footer: `
            <button class="btn btn-ghost cancel-btn">${Utils.escapeHtml(cancelText)}</button>
            <button class="btn ${confirmClass} confirm-btn">${Utils.escapeHtml(confirmText)}</button>`,
          onClose: () => resolve(false)
        });
        el.querySelector('.cancel-btn').addEventListener('click', () => { close(); resolve(false); });
        el.querySelector('.confirm-btn').addEventListener('click', () => { close(); resolve(true); });
      });
    }

    return { create, confirm };
  })();

  /* ── Sidebar toggle ─────────────────────────────────────── */
  function initSidebar() {
    const sidebar = document.querySelector('.app-sidebar');
    const main    = document.querySelector('.app-main');
    const overlay = document.querySelector('.sidebar-overlay');
    const toggleBtn = document.querySelector('.sidebar-toggle-btn');
    if (!sidebar) return;

    const isMobile = () => window.innerWidth <= 1024;

    function toggle() {
      if (isMobile()) {
        sidebar.classList.toggle('mobile-open');
        overlay?.classList.toggle('show');
      } else {
        sidebar.classList.toggle('collapsed');
        main?.classList.toggle('expanded');
        localStorage.setItem('sidebarCollapsed', sidebar.classList.contains('collapsed'));
      }
    }

    toggleBtn?.addEventListener('click', toggle);
    overlay?.addEventListener('click', () => {
      sidebar.classList.remove('mobile-open');
      overlay.classList.remove('show');
    });

    // Restore state on desktop
    if (!isMobile() && localStorage.getItem('sidebarCollapsed') === 'true') {
      sidebar.classList.add('collapsed');
      main?.classList.add('expanded');
    }
  }

  /* ── Active nav item ────────────────────────────────────── */
  function initNav() {
    const page = window.location.pathname.split('/').pop() || 'dashboard.html';
    document.querySelectorAll('.nav-item').forEach(item => {
      if (item.dataset.page === page) item.classList.add('active');
      item.addEventListener('click', () => {
        if (item.dataset.page) window.location.href = item.dataset.page;
      });
    });
  }

  /* ── Dropdown menus ─────────────────────────────────────── */
  function initDropdowns() {
    document.addEventListener('click', e => {
      const trigger = e.target.closest('[data-dropdown]');
      const menus   = document.querySelectorAll('.dropdown-menu.open');

      if (trigger) {
        const targetId = trigger.dataset.dropdown;
        const menu     = document.getElementById(targetId);
        const isOpen   = menu?.classList.contains('open');
        menus.forEach(m => m.classList.remove('open'));
        if (menu && !isOpen) menu.classList.add('open');
      } else {
        menus.forEach(m => m.classList.remove('open'));
      }
    });
  }

  /* ── Tabs ───────────────────────────────────────────────── */
  function initTabs(container = document) {
    container.querySelectorAll('.tabs-nav .tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.closest('[data-tab-group]') || btn.closest('.tabs-nav').parentElement;
        group.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        group.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        const pane = group.querySelector(`[data-tab="${btn.dataset.tab}"]`);
        pane?.classList.add('active');
      });
    });
  }

  /* ── User menu in header ────────────────────────────────── */
  function initUserMenu() {
    const sess = Auth.getCurrentUser?.();
    if (!sess) return;

    const avatarEl = document.querySelector('.user-avatar');
    if (avatarEl) {
      avatarEl.textContent = Utils.getInitials(sess.displayName || sess.username);
    }

    const logoutBtn = document.querySelector('[data-action="logout"]');
    logoutBtn?.addEventListener('click', async () => {
      const ok = await Modal.confirm({
        title: 'Sign Out',
        message: 'Are you sure you want to sign out?',
        confirmText: 'Sign Out',
        confirmClass: 'btn-primary',
        cancelText: 'Cancel'
      });
      if (ok) Auth.logout();
    });
  }

  /* ── Breadcrumb builder ─────────────────────────────────── */
  function setBreadcrumb(items = []) {
    const bar = document.querySelector('.breadcrumb-bar');
    if (!bar) return;
    bar.innerHTML = items.map((item, i) => {
      const isLast = i === items.length - 1;
      const icon   = item.icon ? `<i class="fa-solid ${item.icon}"></i>` : '';
      return `
        ${i > 0 ? '<span class="bc-sep"><i class="fa-solid fa-chevron-right"></i></span>' : ''}
        <span class="bc-item ${isLast ? 'active' : ''}">
          ${icon} ${Utils.escapeHtml(item.label)}
        </span>`;
    }).join('');
  }

  /* ── Global header search ───────────────────────────────── */
  function initHeaderSearch() {
    const input = document.querySelector('.header-search input');
    if (!input) return;
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && input.value.trim()) {
        window.location.href = `user.html?search=${encodeURIComponent(input.value.trim())}`;
      }
    });
  }

  /* ── Render sidebar user info ───────────────────────────── */
  function renderSidebarUser() {
    const sess = Auth.getCurrentUser?.();
    if (!sess) return;
    const nameEl = document.querySelector('.sidebar-user .s-name');
    const roleEl = document.querySelector('.sidebar-user .s-role');
    const avEl   = document.querySelector('.sidebar-user .s-avatar');
    if (nameEl) nameEl.textContent = sess.displayName || sess.username;
    if (roleEl) roleEl.textContent = Auth.getRoleInfo?.(sess.role)?.label || sess.role;
    if (avEl)   avEl.textContent   = Utils.getInitials(sess.displayName || sess.username);
  }

  /* ── Bootstrap ──────────────────────────────────────────── */
  async function init() {
    await Database.open();
    initSidebar();
    initNav();
    initDropdowns();
    initTabs();
    initUserMenu();
    initHeaderSearch();
    renderSidebarUser();
    Auth.startInactivityWatch?.();
    await Audit.pruneOlderThan?.(90).catch(() => {});
  }

  return { init, Toast, Loader, Modal, setBreadcrumb, initTabs };
})();
