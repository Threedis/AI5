/**
 * audit.js — Audit log management using IndexedDB
 * Employee Expense Verification System
 */

const Audit = (() => {

  /* ── Write a log entry ──────────────────────────────────── */
  async function log({ module = '', action = '', status = 'success', detail = '' }) {
    try {
      const sess = Auth.getCurrentUser?.() || {};
      const entry = {
        username: sess.username || 'system',
        module,
        action,
        status,
        detail,
      };
      await Database.add('auditLogs', entry);
    } catch (err) {
      console.warn('[Audit] Failed to write log:', err);
    }
  }

  /* ── Get recent logs ────────────────────────────────────── */
  async function getRecent(limit = 50) {
    try {
      const all = await Database.getAll('auditLogs');
      return all
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, limit);
    } catch { return []; }
  }

  /* ── Get logs by filter ─────────────────────────────────── */
  async function getFiltered({ user, role, module: mod, action, status, from, to } = {}) {
    try {
      let logs = await Database.getAll('auditLogs');
      if (user)   logs = logs.filter(l => l.user === user);
      if (role)   logs = logs.filter(l => l.role === role);
      if (mod)    logs = logs.filter(l => l.module === mod);
      if (action) logs = logs.filter(l => l.action === action);
      if (status) logs = logs.filter(l => l.status === status);
      if (from)   logs = logs.filter(l => new Date(l.date) >= new Date(from));
      if (to)     logs = logs.filter(l => new Date(l.date) <= new Date(to));
      return logs.sort((a, b) => new Date(b.date) - new Date(a.date));
    } catch { return []; }
  }

  /* ── Clear old logs (keep last N days) ──────────────────── */
  async function pruneOlderThan(days = 90) {
    try {
      const cutoff = new Date(Date.now() - days * 86400000);
      const all  = await Database.getAll('auditLogs');
      const old  = all.filter(l => new Date(l.date) < cutoff);
      for (const entry of old) await Database.delete('auditLogs', entry.id);
    } catch (err) {
      console.warn('[Audit] Prune failed:', err);
    }
  }

  return { log, getRecent, getFiltered, pruneOlderThan };
})();
