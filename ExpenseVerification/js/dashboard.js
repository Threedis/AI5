/**
 * dashboard.js — Dashboard cards, charts, and activity feed
 * Employee Expense Verification System
 */

const Dashboard = (() => {

  let charts = {};

  /* ── Load stats cards ───────────────────────────────────── */
  async function loadStats() {
    try {
      const [hrVersions, accountsBatches, verifications, users] = await Promise.all([
        Database.getAll('versionHistory'),
        Database.getAll('accountsMaster'),
        Database.getAll('verifications'),
        Database.getAll('users')
      ]);

      const hrVers  = hrVersions.filter(v => v.type === 'hr');
      const accBatches = [...new Set(accountsBatches.map(r => r.batchId))];
      const pending = verifications.filter(v => v.status === 'pending').length;
      const matched = verifications.filter(v => v.status === 'matched').length;
      const mismatch = verifications.filter(v => v.status === 'mismatch').length;

      const today = new Date().toDateString();
      const todayUploads = hrVersions.filter(v =>
        new Date(v.uploadedAt).toDateString() === today).length;

      setStatCard('stat-hr-upload',     hrVers.length ? `v${hrVers[hrVers.length-1]?.version || '—'}` : '—');
      setStatCard('stat-acc-upload',    accBatches.length || '0');
      setStatCard('stat-pending',       pending || '0');
      setStatCard('stat-matched',       matched || '0');
      setStatCard('stat-mismatch',      mismatch || '0');
      setStatCard('stat-today-uploads', todayUploads || '0');
    } catch (err) {
      console.error('[Dashboard] loadStats error:', err);
    }
  }

  function setStatCard(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  /* ── Activity feed ──────────────────────────────────────── */
  async function loadActivity() {
    const container = document.getElementById('activity-feed');
    if (!container) return;

    const logs = await Audit.getRecent(15);
    if (!logs.length) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon"><i class="fa-regular fa-clock"></i></div>
          <h5>No recent activity</h5>
          <p>Activity will appear here once users start working.</p>
        </div>`;
      return;
    }

    const colorMap = {
      success: 'blue', error: 'red', warning: 'orange'
    };
    const iconMap = {
      Login: 'fa-right-to-bracket', Logout: 'fa-right-from-bracket',
      Upload: 'fa-upload', Delete: 'fa-trash',
      Verify: 'fa-circle-check', Backup: 'fa-cloud-arrow-up',
      Restore: 'fa-rotate-left', default: 'fa-circle-dot'
    };

    container.innerHTML = logs.map(log => {
      const color = colorMap[log.status] || 'blue';
      const icon  = iconMap[log.action]  || iconMap.default;
      return `
        <div class="activity-item">
          <div class="activity-dot stat-icon ${color}">
            <i class="fa-solid ${icon}"></i>
          </div>
          <div class="activity-text">
            <strong>${Utils.escapeHtml(log.user)}</strong>
            ${Utils.escapeHtml(log.action)} in ${Utils.escapeHtml(log.module)}
            ${log.detail ? `<br><span style="font-size:.78rem;color:var(--text-muted)">${Utils.escapeHtml(log.detail)}</span>` : ''}
          </div>
          <div class="activity-time">${Utils.timeAgo(log.date)}</div>
        </div>`;
    }).join('');
  }

  /* ── Monthly Upload Chart ───────────────────────────────── */
  async function initMonthlyChart() {
    const canvas = document.getElementById('chart-monthly');
    if (!canvas || !window.Chart) return;

    const versions = await Database.getAll('versionHistory');
    const months   = getLast6Months();
    const hrData   = months.map(m => versions.filter(v =>
      v.type === 'hr' && isSameMonth(v.uploadedAt, m)).length);
    const accData  = months.map(m => versions.filter(v =>
      v.type === 'accounts' && isSameMonth(v.uploadedAt, m)).length);

    charts.monthly?.destroy();
    charts.monthly = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: months.map(m => m.label),
        datasets: [
          { label: 'HR Uploads',       data: hrData,  backgroundColor: '#0078D4', borderRadius: 6 },
          { label: 'Account Uploads',  data: accData, backgroundColor: '#038387', borderRadius: 6 }
        ]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: {
          y: { beginAtZero: true, ticks: { stepSize: 1 }, grid: { color: '#E1EAEF' } },
          x: { grid: { display: false } }
        }
      }
    });
  }

  /* ── Verification Status Donut ──────────────────────────── */
  async function initStatusChart() {
    const canvas = document.getElementById('chart-status');
    if (!canvas || !window.Chart) return;

    const all      = await Database.getAll('verifications');
    const matched  = all.filter(v => v.status === 'matched').length;
    const mismatch = all.filter(v => v.status === 'mismatch').length;
    const missing  = all.filter(v => v.status === 'missing').length;
    const pending  = all.filter(v => v.status === 'pending').length;

    charts.status?.destroy();
    charts.status = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: ['Matched', 'Mismatch', 'Missing', 'Pending'],
        datasets: [{
          data: [matched, mismatch, missing, pending],
          backgroundColor: ['#107C10', '#A4262C', '#FFB900', '#0078D4'],
          borderWidth: 0, hoverOffset: 6
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true } }
        }
      }
    });
  }

  /* ── Date helpers ───────────────────────────────────────── */
  function getLast6Months() {
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setMonth(d.getMonth() - i, 1);
      months.push({
        date:  new Date(d),
        label: d.toLocaleString('default', { month: 'short', year: '2-digit' })
      });
    }
    return months;
  }

  function isSameMonth(dateStr, monthObj) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return d.getFullYear() === monthObj.date.getFullYear() &&
           d.getMonth()    === monthObj.date.getMonth();
  }

  /* ── Init ───────────────────────────────────────────────── */
  async function init() {
    await loadStats();
    await loadActivity();
    await initMonthlyChart();
    await initStatusChart();
  }

  return { init, loadStats, loadActivity };
})();
