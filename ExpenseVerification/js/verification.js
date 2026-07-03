/**
 * verification.js — Cross-match HR Master vs Accounts Master
 * Compares account numbers, IFSC codes, and beneficiary names
 * and produces a structured verification result per employee.
 */

const Verification = (() => {

  /* ── Status constants ────────────────────────────────────── */
  const STATUS = {
    MATCHED:        'Matched',
    MISMATCH:       'Mismatch',
    MISSING_IN_ACC: 'Missing in Accounts',
    MISSING_IN_HR:  'Missing in HR',
    PARTIAL:        'Partial Match',
  };

  /* ── Name similarity (simple token overlap) ──────────────── */
  function nameSimilarity(a, b) {
    if (!a || !b) return 0;
    const tokA = a.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
    const tokB = b.toLowerCase().replace(/[^a-z\s]/g, '').split(/\s+/).filter(Boolean);
    if (!tokA.length || !tokB.length) return 0;
    const setB  = new Set(tokB);
    const common = tokA.filter(t => setB.has(t)).length;
    return common / Math.max(tokA.length, tokB.length);
  }

  /* ── Compare a single HR record against an Accounts record ─ */
  function compareRecords(hr, acc) {
    const issues   = [];
    let   matched  = 0;
    let   checked  = 0;

    // Account number (primary key comparison)
    checked++;
    if (hr.bankAccountNumber && acc.accountNo) {
      const hrAcc  = hr.bankAccountNumber.replace(/[^0-9]/g, '');
      const acAcc  = acc.accountNo.replace(/[^0-9]/g, '');
      if (hrAcc === acAcc) {
        matched++;
      } else {
        issues.push({ field: 'accountNo', hrValue: hr.bankAccountNumber, accValue: acc.accountNo, severity: 'error' });
      }
    } else if (!hr.bankAccountNumber) {
      issues.push({ field: 'accountNo', hrValue: '(blank)', accValue: acc.accountNo, severity: 'warning' });
    } else {
      issues.push({ field: 'accountNo', hrValue: hr.bankAccountNumber, accValue: '(blank)', severity: 'warning' });
    }

    // IFSC code
    checked++;
    if (hr.ifsc && acc.ifsc) {
      if (hr.ifsc.toUpperCase() === acc.ifsc.toUpperCase()) {
        matched++;
      } else {
        issues.push({ field: 'ifsc', hrValue: hr.ifsc, accValue: acc.ifsc, severity: 'error' });
      }
    } else if (!hr.ifsc) {
      issues.push({ field: 'ifsc', hrValue: '(blank)', accValue: acc.ifsc, severity: 'warning' });
    } else {
      issues.push({ field: 'ifsc', hrValue: hr.ifsc, accValue: '(blank)', severity: 'warning' });
    }

    // Name in bank (fuzzy token match)
    checked++;
    const hrName  = hr.nameInBank  || hr.employeeName || '';
    const accName = acc.nameInBank || acc.empName      || '';
    if (hrName && accName) {
      const sim = nameSimilarity(hrName, accName);
      if (sim >= 0.6) {
        matched++;
        if (sim < 1.0) {
          issues.push({ field: 'nameInBank', hrValue: hrName, accValue: accName, severity: 'info' });
        }
      } else {
        issues.push({ field: 'nameInBank', hrValue: hrName, accValue: accName, severity: 'warning' });
      }
    } else {
      // No name to compare — not a hard error
      matched++;
    }

    let status;
    const errorCount = issues.filter(i => i.severity === 'error').length;
    if (errorCount > 0)         status = STATUS.MISMATCH;
    else if (matched === checked) status = STATUS.MATCHED;
    else                          status = STATUS.PARTIAL;

    return { status, issues, score: matched / checked };
  }

  /* ── Build lookup indexes for fast access ────────────────── */
  function buildAccIndex(accRecords) {
    const byAccNo   = new Map();
    const byEmpCode = new Map();

    accRecords.forEach(rec => {
      if (rec.accountNo) {
        const key = rec.accountNo.replace(/[^0-9]/g, '');
        if (!byAccNo.has(key)) byAccNo.set(key, []);
        byAccNo.get(key).push(rec);
      }
      if (rec.empCode) {
        const key = rec.empCode.toUpperCase();
        if (!byEmpCode.has(key)) byEmpCode.set(key, []);
        byEmpCode.get(key).push(rec);
      }
    });

    return { byAccNo, byEmpCode };
  }

  /* ── Run full verification (HR vs Accounts) ──────────────── */
  async function runVerification(options = {}) {
    const { filterEmpIds = null } = options; // optional array of emp IDs to limit scope

    const hrRecords  = await Database.getAll('hrMaster');
    const accRecords = await Database.getAll('accountsMaster');

    if (!hrRecords.length)  throw new Error('No HR Master data. Upload HR file first.');
    if (!accRecords.length) throw new Error('No Accounts data. Upload bank advice file first.');

    const accIdx = buildAccIndex(accRecords);
    const results = [];
    const accMatched = new Set(); // track which acc records were matched

    // For each HR record, find best accounts match
    for (const hr of hrRecords) {
      if (filterEmpIds && !filterEmpIds.includes(hr.employeeId)) continue;

      const hrAccNo  = (hr.bankAccountNumber || '').replace(/[^0-9]/g, '');
      const hrEmpCode = (hr.employeeId || '').toUpperCase();

      // Try match by account number first, then by emp code
      let accCandidates = [];
      if (hrAccNo && accIdx.byAccNo.has(hrAccNo)) {
        accCandidates = accIdx.byAccNo.get(hrAccNo);
      } else if (hrEmpCode && accIdx.byEmpCode.has(hrEmpCode)) {
        accCandidates = accIdx.byEmpCode.get(hrEmpCode);
      }

      if (!accCandidates.length) {
        results.push({
          id:        Utils.uuid(),
          hr,
          acc:       null,
          status:    STATUS.MISSING_IN_ACC,
          issues:    [{ field: 'all', hrValue: hr.bankAccountNumber, accValue: null, severity: 'error' }],
          score:     0,
          empId:     hr.employeeId,
          empName:   hr.employeeName,
          amount:    0,
          verifiedAt: new Date().toISOString(),
        });
        continue;
      }

      // Pick best matching candidate
      let best = null, bestScore = -1;
      for (const acc of accCandidates) {
        const cmp = compareRecords(hr, acc);
        if (cmp.score > bestScore) { bestScore = cmp.score; best = { acc, cmp }; }
      }

      accMatched.add(best.acc.id);
      results.push({
        id:        Utils.uuid(),
        hr,
        acc:       best.acc,
        status:    best.cmp.status,
        issues:    best.cmp.issues,
        score:     best.cmp.score,
        empId:     hr.employeeId || best.acc.empCode,
        empName:   hr.employeeName || best.acc.empName,
        amount:    best.acc.netPay || 0,
        verifiedAt: new Date().toISOString(),
      });
    }

    // Accounts records not matched to any HR record
    for (const acc of accRecords) {
      if (accMatched.has(acc.id)) continue;
      results.push({
        id:        Utils.uuid(),
        hr:        null,
        acc,
        status:    STATUS.MISSING_IN_HR,
        issues:    [{ field: 'all', hrValue: null, accValue: acc.accountNo, severity: 'warning' }],
        score:     0,
        empId:     acc.empCode,
        empName:   acc.empName,
        amount:    acc.netPay || 0,
        verifiedAt: new Date().toISOString(),
      });
    }

    const summary = {
      total:          results.length,
      matched:        results.filter(r => r.status === STATUS.MATCHED).length,
      partial:        results.filter(r => r.status === STATUS.PARTIAL).length,
      mismatch:       results.filter(r => r.status === STATUS.MISMATCH).length,
      missingInAcc:   results.filter(r => r.status === STATUS.MISSING_IN_ACC).length,
      missingInHR:    results.filter(r => r.status === STATUS.MISSING_IN_HR).length,
    };

    await Audit.log({
      module: 'Verification',
      action: 'RunVerification',
      status: 'success',
      detail: `Total: ${summary.total}, Matched: ${summary.matched}, Mismatch: ${summary.mismatch}`,
    });

    return { results, summary };
  }

  /* ── Run verification limited to emp IDs from a PDF ─────── */
  async function runForApproval(approvalData) {
    const { empIds, rawText } = approvalData;

    if (!empIds || !empIds.length) {
      // No specific emp IDs extracted — run full verification
      return runVerification();
    }

    return runVerification({ filterEmpIds: empIds });
  }

  /* ── Save verification session to IndexedDB ─────────────── */
  async function saveSession(results, summary, meta = {}) {
    const session = {
      id:          Utils.uuid(),
      createdAt:   new Date().toISOString(),
      createdBy:   meta.createdBy || 'system',
      source:      meta.source    || 'manual',
      pdfFile:     meta.pdfFile   || null,
      summary,
      encResults:  await Encryption.encryptWithAppKey(results),
    };
    await Database.put('verifications', session);
    return session.id;
  }

  /* ── Load a verification session ────────────────────────── */
  async function loadSession(sessionId) {
    const session = await Database.get('verifications', sessionId);
    if (!session) throw new Error('Session not found');
    const results = await Encryption.decryptWithAppKey(session.encResults);
    return { ...session, results };
  }

  /* ── Get all sessions (without decrypting results) ───────── */
  async function getSessions() {
    const all = await Database.getAll('verifications');
    return all
      .map(s => ({ id: s.id, createdAt: s.createdAt, createdBy: s.createdBy, source: s.source, pdfFile: s.pdfFile, summary: s.summary }))
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /* ── Delete a session ────────────────────────────────────── */
  async function deleteSession(sessionId) {
    await Database.remove('verifications', sessionId);
  }

  /* ── Generate Excel discrepancy report (ExcelJS) ─────────── */
  async function generateDiscrepancyReport(results) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ExpenseVerify';
    wb.created = new Date();

    const hdrStyle = {
      font:      { bold: true, color: { argb: 'FFFFFFFF' } },
      fill:      { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0078D4' } },
      alignment: { horizontal: 'center' },
    };

    const statusColor = {
      [STATUS.MATCHED]:        'FFDFF6DD',
      [STATUS.PARTIAL]:        'FFFFF4CE',
      [STATUS.MISMATCH]:       'FFFDE7E9',
      [STATUS.MISSING_IN_ACC]: 'FFFDE7E9',
      [STATUS.MISSING_IN_HR]:  'FFFFF4CE',
    };

    /* Summary */
    const sum   = wb.addWorksheet('Summary');
    const stats = {
      [STATUS.MATCHED]:        results.filter(r => r.status === STATUS.MATCHED).length,
      [STATUS.PARTIAL]:        results.filter(r => r.status === STATUS.PARTIAL).length,
      [STATUS.MISMATCH]:       results.filter(r => r.status === STATUS.MISMATCH).length,
      [STATUS.MISSING_IN_ACC]: results.filter(r => r.status === STATUS.MISSING_IN_ACC).length,
      [STATUS.MISSING_IN_HR]:  results.filter(r => r.status === STATUS.MISSING_IN_HR).length,
    };
    sum.columns = [{ width: 28 }, { width: 14 }];
    sum.addRow(['Verification Report']).font = { bold: true, size: 14, color: { argb: 'FF0078D4' } };
    sum.addRow(['Generated', new Date().toLocaleString()]);
    sum.addRow([]);
    sum.addRow(['Total Records', results.length]);
    Object.entries(stats).forEach(([k, v]) => sum.addRow([k, v]));

    /* All Records */
    const ar = wb.addWorksheet('Verification Results');
    ar.columns = [
      { header: 'Emp ID',       key: 'empId',      width: 14 },
      { header: 'HR Name',      key: 'hrName',     width: 26 },
      { header: 'Acc Name',     key: 'accName',    width: 26 },
      { header: 'Amount',       key: 'amount',     width: 14 },
      { header: 'HR Account',   key: 'hrAcc',      width: 22 },
      { header: 'Acc Account',  key: 'accAcc',     width: 22 },
      { header: 'HR IFSC',      key: 'hrIfsc',     width: 16 },
      { header: 'Acc IFSC',     key: 'accIfsc',    width: 16 },
      { header: 'HR Name Bank', key: 'hrNameBank', width: 26 },
      { header: 'Acc Name Bank',key: 'accNameBank',width: 26 },
      { header: 'Status',       key: 'status',     width: 18 },
      { header: 'Issues',       key: 'issues',     width: 40 },
    ];
    ar.getRow(1).eachCell(c => Object.assign(c, hdrStyle));

    results.forEach(r => {
      const row = ar.addRow({
        empId:      r.empId,
        hrName:     r.hr?.employeeName  || '',
        accName:    r.acc?.empName       || '',
        amount:     r.amount,
        hrAcc:      r.hr?.bankAccountNumber || '',
        accAcc:     r.acc?.accountNo        || '',
        hrIfsc:     r.hr?.ifsc              || '',
        accIfsc:    r.acc?.ifsc             || '',
        hrNameBank: r.hr?.nameInBank        || '',
        accNameBank:r.acc?.nameInBank       || '',
        status:     r.status,
        issues:     r.issues.map(i => `${i.field}: HR=${i.hrValue} | Acc=${i.accValue}`).join('; '),
      });
      const color = statusColor[r.status] || 'FFFFFFFF';
      row.eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } }; });
    });

    /* Mismatches only */
    const mis = wb.addWorksheet('Mismatches');
    mis.columns = ar.columns;
    mis.getRow(1).eachCell(c => Object.assign(c, { ...hdrStyle, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA4262C' } } }));
    results.filter(r => r.status === STATUS.MISMATCH || r.status === STATUS.MISSING_IN_ACC).forEach(r => {
      mis.addRow({
        empId: r.empId, hrName: r.hr?.employeeName || '', accName: r.acc?.empName || '',
        amount: r.amount, hrAcc: r.hr?.bankAccountNumber || '', accAcc: r.acc?.accountNo || '',
        hrIfsc: r.hr?.ifsc || '', accIfsc: r.acc?.ifsc || '',
        hrNameBank: r.hr?.nameInBank || '', accNameBank: r.acc?.nameInBank || '',
        status: r.status, issues: r.issues.map(i => `${i.field}: HR=${i.hrValue} | Acc=${i.accValue}`).join('; '),
      }).eachCell(c => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7E9' } }; });
    });

    const buf = await wb.xlsx.writeBuffer();
    Utils.downloadBlob(
      new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `Verification_Report_${new Date().toISOString().slice(0, 10)}.xlsx`
    );
  }

  /* ── Generate HDFC payment file (pipe-delimited text) ───── */
  function generateHDFCFile(results) {
    const matched = results.filter(r => r.status === STATUS.MATCHED || r.status === STATUS.PARTIAL);
    if (!matched.length) throw new Error('No matched records to generate payment file.');

    const lines = [
      '# HDFC Payment File',
      `# Generated: ${new Date().toISOString()}`,
      '# Format: ACNO|NAME|IFSC|AMOUNT|REMARKS',
      '',
      ...matched.map(r => {
        const acc    = r.acc || r.hr;
        const acNo   = (acc?.accountNo || r.hr?.bankAccountNumber || '').replace(/[^0-9]/g, '');
        const name   = acc?.nameInBank || acc?.empName || r.hr?.employeeName || '';
        const ifsc   = acc?.ifsc       || r.hr?.ifsc   || '';
        const amount = (r.amount || 0).toFixed(2);
        const remarks = `EMP:${r.empId || ''}`;
        return `${acNo}|${name}|${ifsc}|${amount}|${remarks}`;
      }),
    ];

    Utils.downloadBlob(
      new Blob([lines.join('\r\n')], { type: 'text/plain' }),
      `HDFC_Payment_${new Date().toISOString().slice(0, 10)}.txt`
    );
    return matched.length;
  }

  /* ── Generate NES format (CSV) ───────────────────────────── */
  function generateNESFile(results) {
    const matched = results.filter(r => r.status === STATUS.MATCHED || r.status === STATUS.PARTIAL);
    if (!matched.length) throw new Error('No matched records to generate NES file.');

    const header = 'SLNO,EMP_CODE,EMP_NAME,BANK_NAME,ACCOUNT_NO,IFSC,NET_PAY,PAN,NAME_IN_BANK';
    const rows = matched.map((r, i) => {
      const acc = r.acc || {};
      const hr  = r.hr  || {};
      return [
        i + 1,
        r.empId || acc.empCode || hr.employeeId || '',
        `"${(r.empName || '').replace(/"/g, '')}"`,
        `"${(acc.bankName || '').replace(/"/g, '')}"`,
        acc.accountNo || hr.bankAccountNumber || '',
        acc.ifsc      || hr.ifsc              || '',
        (r.amount || 0).toFixed(2),
        acc.pan       || hr.pan               || '',
        `"${(acc.nameInBank || hr.nameInBank || '').replace(/"/g, '')}"`,
      ].join(',');
    });

    Utils.downloadBlob(
      new Blob([[header, ...rows].join('\r\n')], { type: 'text/csv' }),
      `NES_Payment_${new Date().toISOString().slice(0, 10)}.csv`
    );
    return matched.length;
  }

  /* ── Cross-database employee search ─────────────────────── */
  async function searchEmployees(term, field = 'all') {
    const hrAll  = await Database.getAll('hrMaster');
    const accAll = await Database.getAll('accountsMaster');
    const q      = term.toLowerCase();

    const HR_FIELDS = {
      empId:   ['employeeId'],
      name:    ['employeeName'],
      account: ['bankAccountNumber'],
      pan:     ['pan'],
      ifsc:    ['ifsc'],
    };
    const ACC_FIELDS = {
      empId:   ['empCode'],
      name:    ['empName'],
      account: ['accountNo'],
      pan:     ['pan'],
      ifsc:    ['ifsc'],
    };

    function matchRec(rec, fieldMap) {
      if (field === 'all') return Object.values(rec).some(v => String(v ?? '').toLowerCase().includes(q));
      return (fieldMap[field] || []).some(k => String(rec[k] ?? '').toLowerCase().includes(q));
    }

    const hrResults  = hrAll.filter(r => matchRec(r, HR_FIELDS)).map(r => ({
      source:    'HR',
      empId:     r.employeeId,
      name:      r.employeeName,
      bank:      r.bankName,
      accountNo: r.bankAccountNumber,
      ifsc:      r.ifsc,
      nameInBank:r.nameInBank,
      pan:       r.pan,
      department:r.division || r.department,
      raw:       r,
    }));

    const accResults = accAll.filter(r => matchRec(r, ACC_FIELDS)).map(r => ({
      source:    'Accounts',
      empId:     r.empCode,
      name:      r.empName,
      bank:      r.bankName,
      accountNo: r.accountNo,
      ifsc:      r.ifsc,
      nameInBank:r.nameInBank,
      pan:       r.pan,
      netPay:    r.netPay,
      department:r.department,
      raw:       r,
    }));

    return [...hrResults, ...accResults];
  }

  return {
    STATUS,
    runVerification,
    runForApproval,
    saveSession,
    loadSession,
    getSessions,
    deleteSession,
    generateDiscrepancyReport,
    generateHDFCFile,
    generateNESFile,
    searchEmployees,
  };
})();
