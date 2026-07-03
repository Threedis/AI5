/**
 * dashboard.js — Dashboard stats, charts, and activity feed
 * Employee Expense Verification System
 */

const Dashboard = (() => {

  let charts = {};

  /* ── Stat card helper ───────────────────────────────────── */
  function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  /* ── Load stat cards ─────────────────────────────────────── */
  async function loadStats() {
    try {
      const [hrVersions, accBatches, verifySessions, hrMaster, accMaster] = await Promise.all([
        Database.getAll('versionHistory'),
        Database.getAll('accountsBatches'),
        Database.getAll('verifications'),
        Database.getAll('hrMaster'),
        Database.getAll('accountsMaster'),
      ]);

      // Latest active HR version
      const hrVers   = hrVersions.filter(v => v.type === 'hr').sort((a,b) => b.version - a.version);
      const activeHR = hrVers.find(v => v.isActive);
      setEl('stat-hr-upload', activeHR ? `v${activeHR.version} (${hrMaster.length} rec)` : hrVers.length ? `v${hrVers[0].version}` : '—');
      setEl('stat-hr-date',   activeHR ? Utils.timeAgo(activeHR.uploadedAt) : '—');

      // Account batches
      const activeBatch = accBatches.find(b => b.isActive);
      setEl('stat-acc-upload', accBatches.length ? `${accBatches.length} batch${accBatches.length>1?'es':''}` : '0');
      setEl('stat-acc-date',   activeBatch ? Utils.timeAgo(activeBatch.uploadedAt) : '—');

      // Verification stats from latest session
      const latestSession = verifySessions.sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt))[0];
      const sum = latestSession?.summary || {};
      const hrCount  = hrMaster.length;
      const accCount = accMaster.length;
      const pending  = Math.max(0, hrCount - (sum.matched || 0) - (sum.mismatch || 0));

      setEl('stat-pending',  pending || '0');
      setEl('stat-matched',  sum.matched  || '0');
      setEl('stat-mismatch', sum.mismatch || '0');

      // Today's uploads (HR versions + account batches uploaded today)
      const today = new Date().toDateString();
      const todayUploads = [
        ...hrVersions.filter(v  => new Date(v.uploadedAt).toDateString()  === today),
        ...accBatches.filter(b  => new Date(b.uploadedAt).toDateString()  === today),
      ].length;
      setEl('stat-today-uploads', todayUploads || '0');

    } catch (err) {
      console.error('[Dashboard] loadStats:', err);
    }
  }

  /* ── Activity feed ──────────────────────────────────────── */
  async function loadActivity() {
    const container = document.getElementById('activity-feed');
    if (!container) return;

    const logs = await Audit.getRecent(15);
    if (!logs.length) {
      container.innerHTML = `<div class="empty-state">
        <div class="empty-icon"><i class="fa-regular fa-clock"></i></div>
        <h5>No recent activity</h5>
        <p>Activity will appear here once users start working.</p>
      </div>`;
      return;
    }

    const colorMap = { success:'blue', error:'red', warning:'orange' };
    const iconMap  = {
      Login:'fa-right-to-bracket', Logout:'fa-right-from-bracket',
      PageView:'fa-eye',
      FilesParsed:'fa-wand-magic-sparkles', BatchSaved:'fa-database',
      BatchRestored:'fa-rotate-left', BatchDeleted:'fa-trash',
      CreateUser:'fa-user-plus', UpdateUser:'fa-pen', DeleteUser:'fa-trash',
      ToggleUser:'fa-toggle-on', SaveSettings:'fa-sliders',
      RunVerification:'fa-shield-check', PushBackup:'fa-cloud-arrow-up',
      RestoreBackup:'fa-cloud-arrow-down', Extract:'fa-file-pdf',
      default:'fa-circle-dot',
    };

    container.innerHTML = logs.map(log => {
      const color = colorMap[log.status] || 'blue';
      const icon  = iconMap[log.action]  || iconMap.default;
      return `<div class="activity-item">
        <div class="activity-dot stat-icon ${color}"><i class="fa-solid ${icon}"></i></div>
        <div class="activity-text">
          <strong>${Utils.escapeHtml(log.user)}</strong>
          ${Utils.escapeHtml(log.action)} in ${Utils.escapeHtml(log.module)}
          ${log.detail ? `<br><span style="font-size:.78rem;color:var(--text-muted)">${Utils.escapeHtml(log.detail)}</span>` : ''}
        </div>
        <div class="activity-time">${Utils.timeAgo(log.date)}</div>
      </div>`;
    }).join('');
  }

  /* ── Monthly Upload Bar Chart ────────────────────────────── */
  async function initMonthlyChart() {
    const canvas = document.getElementById('chart-monthly');
    if (!canvas || !window.Chart) return;

    const [hrVersions, accBatches] = await Promise.all([
      Database.getAll('versionHistory'),
      Database.getAll('accountsBatches'),
    ]);

    const months  = getLast6Months();
    const hrData  = months.map(m => hrVersions.filter(v =>
      v.type === 'hr' && isSameMonth(v.uploadedAt, m)).length);
    const accData = months.map(m => accBatches.filter(b =>
      isSameMonth(b.uploadedAt, m)).length);

    charts.monthly?.destroy();
    charts.monthly = new Chart(canvas, {
      type: 'bar',
      data: {
        labels:   months.map(m => m.label),
        datasets: [
          { label:'HR Uploads',      data:hrData,  backgroundColor:'#0078D4', borderRadius:6 },
          { label:'Account Batches', data:accData, backgroundColor:'#038387', borderRadius:6 },
        ],
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ position:'bottom', labels:{ usePointStyle:true, padding:16 } } },
        scales:{
          y:{ beginAtZero:true, ticks:{ stepSize:1 }, grid:{ color:'#E1EAEF' } },
          x:{ grid:{ display:false } },
        },
      },
    });
  }

  /* ── Verification Status Donut ──────────────────────────── */
  async function initStatusChart() {
    const canvas = document.getElementById('chart-status');
    if (!canvas || !window.Chart) return;

    const sessions = await Database.getAll('verifications');
    const latest   = sessions.sort((a,b) => new Date(b.createdAt)-new Date(a.createdAt))[0];
    const sum      = latest?.summary || {};

    const matched     = sum.matched     || 0;
    const partial     = sum.partial     || 0;
    const mismatch    = sum.mismatch    || 0;
    const missingAcc  = sum.missingInAcc|| 0;
    const missingHR   = sum.missingInHR || 0;
    const total = matched + partial + mismatch + missingAcc + missingHR;

    charts.status?.destroy();

    if (!total) {
      canvas.closest('.chart-container').innerHTML = `
        <div class="empty-state" style="padding:30px 0">
          <div class="empty-icon"><i class="fa-solid fa-chart-pie"></i></div>
          <p>No verification data yet</p>
        </div>`;
      return;
    }

    charts.status = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels:   ['Matched','Partial','Mismatch','Missing in Acc','Missing in HR'],
        datasets: [{
          data:            [matched, partial, mismatch, missingAcc, missingHR],
          backgroundColor: ['#107C10','#FFB900','#A4262C','#D83B01','#8764B8'],
          borderWidth: 0, hoverOffset: 6,
        }],
      },
      options: {
        responsive:true, maintainAspectRatio:false,
        cutout:'68%',
        plugins:{
          legend:{ position:'bottom', labels:{ padding:14, usePointStyle:true, font:{ size:11 } } },
          tooltip:{ callbacks:{ label: ctx => ` ${ctx.label}: ${ctx.parsed} (${Math.round(ctx.parsed/total*100)}%)` } },
        },
      },
    });
  }

  /* ── Date helpers ───────────────────────────────────────── */
  function getLast6Months() {
    const months = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      months.push({ date: new Date(d), label: d.toLocaleString('default', { month:'short', year:'2-digit' }) });
    }
    return months;
  }

  function isSameMonth(dateStr, monthObj) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    return d.getFullYear() === monthObj.date.getFullYear() && d.getMonth() === monthObj.date.getMonth();
  }

  /* ── Init ───────────────────────────────────────────────── */
  async function init() {
    await Promise.all([loadStats(), loadActivity()]);
    await initMonthlyChart();
    await initStatusChart();
  }

  return { init, loadStats, loadActivity };
})();
