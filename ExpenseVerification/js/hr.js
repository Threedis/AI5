/**
 * hr.js — HR Excel parser, validator, encryption, versioning
 * Employee Expense Verification System
 */

const HR = (() => {

  /* ── Column mapping (flexible, case-insensitive) ─────────── */
  const COLUMN_MAP = {
    employeeId:        ['employee id','emp id','empid','employee_id','emp_id','employee no','empno','staff id','staff_id'],
    employeeName:      ['employee name','emp name','empname','name','employee_name','emp_name','staff name'],
    month:             ['month','mon','period month'],
    year:              ['year','yr','period year'],
    branch:            ['branch','branch name','branch_name','location'],
    division:          ['division','div','division name','department','dept'],
    bankName:          ['bank name','bank','bankname','bank_name','bank nm'],
    bankAccountNumber: ['bank account number','account number','acc no','account no','bank ac no','bank_account_number','account_number','bank account no','acno','ac no','bankacno','bank a/c no','a/c no','ac number','bank acc no','bank acc number','account_no'],
    ifsc:              ['ifsc','ifsc code','ifsccode','ifsc_code','rtgs code','neft code','bank ifsc','bank ifsc code','ifsc no','bank_ifsc'],
    nameInBank:        ['name in bank','bank account name','account holder name','name as in bank','name_in_bank','beneficiary name','holder name']
  };

  const REQUIRED_COLUMNS = ['employeeId','employeeName'];
  const OPTIONAL_COLUMNS = ['month','year','branch','division','bankName','bankAccountNumber','ifsc'];

  /* ── Parse SheetJS workbook to raw records ───────────────── */
  function parseSheet(workbook) {
    const results   = [];
    const sheetNames = workbook.SheetNames;

    for (const name of sheetNames) {
      const ws   = workbook.Sheets[name];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
      if (rows.length < 2) continue;

      /* Find header row (first row with ≥3 non-empty cells) */
      let headerRowIdx = -1;
      let headerRow    = [];
      for (let i = 0; i < Math.min(rows.length, 10); i++) {
        const nonEmpty = rows[i].filter(c => String(c).trim() !== '').length;
        if (nonEmpty >= 3) { headerRowIdx = i; headerRow = rows[i]; break; }
      }
      if (headerRowIdx === -1) continue;

      /* Map header labels → column indexes */
      const colIdx = mapColumns(headerRow);
      const hasMandatory = REQUIRED_COLUMNS.some(k => colIdx[k] !== undefined);
      if (!hasMandatory) continue;

      /* Parse data rows */
      for (let r = headerRowIdx + 1; r < rows.length; r++) {
        const row = rows[r];
        if (row.every(c => String(c).trim() === '')) continue; // blank row

        /* Skip group/count summary rows anywhere in the sheet.
           Matches patterns like "Jun/2026 : 1477 Item(s)", "Total: 500",
           "Group Count 200", etc. — any row where a cell contains a
           record-count pattern AND the Employee ID column is blank. */
        const empIdVal = colIdx.employeeId !== undefined
          ? String(row[colIdx.employeeId] ?? '').trim()
          : '';
        const isSummaryRow = !empIdVal && row.some(c => {
          const v = String(c ?? '').trim();
          return /\d+\s*item\(s\)/i.test(v)           // "1477 Item(s)"
            || /\bitem\(s\)\b/i.test(v)               // bare "Item(s)"
            || /\btotal\b.*\d/i.test(v)               // "Total: 500"
            || /\bcount\b.*\d/i.test(v)               // "Count: 200"
            || /\bgroup\b.*\d/i.test(v)               // "Group 3: 150"
            || /\d+\s*record/i.test(v)                // "150 Records"
            || /[a-z]{3}\/\d{4}\s*:/i.test(v);       // "Jun/2026 :"
        });
        if (isSummaryRow) continue;

        const rec = {};
        for (const [field, idx] of Object.entries(colIdx)) {
          rec[field] = idx !== undefined ? String(row[idx] ?? '').trim() : '';
        }
        rec._sheet = name;
        rec._row   = r + 1;
        results.push(rec);
      }
    }
    return results;
  }

  /* ── Map header row to field names ──────────────────────── */
  function mapColumns(headers) {
    const idx = {};
    headers.forEach((h, i) => {
      const normalized = String(h).toLowerCase().trim().replace(/\s+/g, ' ');
      for (const [field, aliases] of Object.entries(COLUMN_MAP)) {
        if (aliases.includes(normalized) && idx[field] === undefined) {
          idx[field] = i;
        }
      }
    });
    return idx;
  }

  /* ── Detect which required columns are missing ───────────── */
  function detectMissingColumns(records) {
    const missing = [];
    for (const col of REQUIRED_COLUMNS) {
      const hasData = records.some(r => r[col] && r[col].trim() !== '');
      if (!hasData) missing.push(col);
    }
    return missing;
  }

  /* ── Full validation engine ──────────────────────────────── */
  function validate(records) {
    const errors   = [];     // { row, field, type, message, value }
    const warnings = [];

    const empIdSeen   = new Map();  // empId → first row
    const accNumSeen  = new Map();  // accountNumber → first row

    records.forEach((rec, i) => {
      const rowNum = rec._row || (i + 2);

      /* 1. Blank Employee ID */
      if (Utils.isEmpty(rec.employeeId)) {
        errors.push({ row: rowNum, field: 'employeeId', type: 'BLANK_EMP_ID',
          message: 'Employee ID is blank', value: '' });
      } else {
        /* 2. Duplicate Employee ID */
        const eid = rec.employeeId.trim().toUpperCase();
        if (empIdSeen.has(eid)) {
          errors.push({ row: rowNum, field: 'employeeId', type: 'DUPLICATE_EMP_ID',
            message: `Duplicate Employee ID — first seen at row ${empIdSeen.get(eid)}`,
            value: rec.employeeId });
        } else {
          empIdSeen.set(eid, rowNum);
        }
      }

      /* 3. Blank Employee Name */
      if (Utils.isEmpty(rec.employeeName)) {
        errors.push({ row: rowNum, field: 'employeeName', type: 'BLANK_NAME',
          message: 'Employee Name is blank', value: '' });
      }

      /* 4. Blank / Invalid Account Number — warning only */
      if (Utils.isEmpty(rec.bankAccountNumber)) {
        warnings.push({ row: rowNum, field: 'bankAccountNumber', type: 'BLANK_ACCOUNT',
          message: 'Bank Account Number is blank', value: '' });
      } else {
        const acc = rec.bankAccountNumber.trim().replace(/\s/g, '');
        /* 5. Duplicate Account Number — still an error (data integrity) */
        if (accNumSeen.has(acc)) {
          errors.push({ row: rowNum, field: 'bankAccountNumber', type: 'DUPLICATE_ACCOUNT',
            message: `Duplicate Account Number — first seen at row ${accNumSeen.get(acc)}`,
            value: rec.bankAccountNumber });
        } else {
          accNumSeen.set(acc, rowNum);
        }
        /* 6. Invalid Account Number format — warning only */
        if (!Utils.isValidAccountNumber(acc)) {
          warnings.push({ row: rowNum, field: 'bankAccountNumber', type: 'INVALID_ACCOUNT',
            message: 'Account number format looks unusual (expected 9–18 digits)',
            value: rec.bankAccountNumber });
        }
      }

      /* 7. Blank / Invalid IFSC — warning only */
      if (Utils.isEmpty(rec.ifsc)) {
        warnings.push({ row: rowNum, field: 'ifsc', type: 'BLANK_IFSC',
          message: 'IFSC code is blank', value: '' });
      } else if (!Utils.isValidIFSC(rec.ifsc.trim().toUpperCase())) {
        warnings.push({ row: rowNum, field: 'ifsc', type: 'INVALID_IFSC',
          message: 'IFSC format looks unusual (expected: XXXX0YYYYYY)',
          value: rec.ifsc });
      }

      /* 8. Missing Branch */
      if (Utils.isEmpty(rec.branch)) {
        warnings.push({ row: rowNum, field: 'branch', type: 'MISSING_BRANCH',
          message: 'Branch is missing', value: '' });
      }

      /* 9. Missing Division */
      if (Utils.isEmpty(rec.division)) {
        warnings.push({ row: rowNum, field: 'division', type: 'MISSING_DIVISION',
          message: 'Division/Department is missing', value: '' });
      }

      /* Name in Bank is not provided in HR Saral exports — no warning */
    });

    return { errors, warnings, isValid: errors.length === 0 };
  }

  /* ── Normalize records before saving ────────────────────── */
  function normalizeRecords(records, version) {
    return records.map((rec, i) => ({
      id:                Utils.uuid(),
      version,
      employeeId:        (rec.employeeId || '').trim().toUpperCase(),
      employeeName:      Utils.titleCase(rec.employeeName || ''),
      month:             (rec.month || '').trim(),
      year:              (rec.year || '').trim(),
      branch:            (rec.branch || '').trim(),
      division:          (rec.division || '').trim(),
      bankName:          (rec.bankName || '').trim(),
      bankAccountNumber: (rec.bankAccountNumber || '').trim().replace(/\s/g, ''),
      ifsc:              (rec.ifsc || '').trim().toUpperCase(),
      nameInBank:        (rec.nameInBank || '').trim(),
      _sheet:            rec._sheet || '',
      _row:              rec._row || (i + 2)
    }));
  }

  /* ── Get next version number ─────────────────────────────── */
  async function getNextVersion() {
    const versions = await Database.getAll('versionHistory');
    const hrVers   = versions.filter(v => v.type === 'hr');
    if (!hrVers.length) return 1;
    return Math.max(...hrVers.map(v => v.version)) + 1;
  }

  /* ── Get latest HR version ───────────────────────────────── */
  async function getLatestVersion() {
    const versions = await Database.getAll('versionHistory');
    const hrVers   = versions.filter(v => v.type === 'hr').sort((a,b) => b.version - a.version);
    return hrVers[0] || null;
  }

  /* ── Save validated records (encrypted) to IndexedDB ─────── */
  async function saveVersion(records, { fileName, uploadedBy, validationSummary }) {
    const version    = await getNextVersion();
    const normalized = normalizeRecords(records, version);
    const dataHash   = Encryption.hash(normalized);

    /* Encrypt the records */
    const encrypted = await Encryption.encryptWithAppKey(normalized);

    /* Store version metadata */
    const versionRecord = {
      id:           Utils.uuid(),
      type:         'hr',
      version,
      fileName,
      uploadedBy,
      uploadedAt:   new Date().toISOString(),
      recordCount:  normalized.length,
      hash:         dataHash,
      encryptedData: encrypted,
      validationSummary,
      isActive:     true
    };

    /* Deactivate all previous HR versions */
    const existing = await Database.getAll('versionHistory');
    for (const v of existing.filter(v => v.type === 'hr' && v.isActive)) {
      await Database.put('versionHistory', { ...v, isActive: false });
    }

    /* Clear old HR master records */
    await Database.clear('hrMaster');

    /* Save new records to hrMaster */
    await Database.bulkPut('hrMaster', normalized);

    /* Save version entry */
    await Database.put('versionHistory', versionRecord);

    return { version, recordCount: normalized.length, hash: dataHash };
  }

  /* ── Restore a previous version ──────────────────────────── */
  async function restoreVersion(versionId) {
    const ver = await Database.get('versionHistory', versionId);
    if (!ver) throw new Error('Version not found');
    if (!ver.encryptedData) throw new Error('No encrypted data in this version');

    const records = await Encryption.decryptWithAppKey(ver.encryptedData);

    /* Deactivate current active */
    const all = await Database.getAll('versionHistory');
    for (const v of all.filter(v => v.type === 'hr' && v.isActive)) {
      await Database.put('versionHistory', { ...v, isActive: false });
    }

    /* Restore to hrMaster */
    await Database.clear('hrMaster');
    await Database.bulkPut('hrMaster', records);

    /* Mark this version as active */
    await Database.put('versionHistory', { ...ver, isActive: true, restoredAt: new Date().toISOString() });

    return { version: ver.version, recordCount: records.length };
  }

  /* ── Delete a version ────────────────────────────────────── */
  async function deleteVersion(versionId) {
    const ver = await Database.get('versionHistory', versionId);
    if (!ver) throw new Error('Version not found');
    if (ver.isActive) throw new Error('Cannot delete the active version');
    await Database.delete('versionHistory', versionId);
  }

  /* ── Search HR records ───────────────────────────────────── */
  async function search(query, field = 'all') {
    const records = await Database.getAll('hrMaster');
    if (!query) return records;
    const q = query.toLowerCase().trim();
    return records.filter(r => {
      if (field === 'all') {
        return Object.values(r).some(v => String(v).toLowerCase().includes(q));
      }
      return String(r[field] || '').toLowerCase().includes(q);
    });
  }

  /* ── Get records for a specific version ──────────────────── */
  async function getVersionRecords(versionId) {
    const ver = await Database.get('versionHistory', versionId);
    if (!ver || !ver.encryptedData) return [];
    return Encryption.decryptWithAppKey(ver.encryptedData);
  }

  /* ── Generate validation report as ExcelJS workbook ─────── */
  async function generateValidationReport(records, validationResult, fileName) {
    if (!window.ExcelJS) throw new Error('ExcelJS not loaded');

    const wb = new ExcelJS.Workbook();
    wb.creator  = 'ExpenseVerify';
    wb.created  = new Date();

    /* ── Summary Sheet ──────────────────────────────────────── */
    const sumWs = wb.addWorksheet('Summary');
    sumWs.columns = [
      { width: 32 }, { width: 20 }
    ];
    const headerStyle = {
      font: { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0078D4' } },
      alignment: { horizontal: 'center' }
    };
    sumWs.mergeCells('A1:B1');
    sumWs.getCell('A1').value = 'HR Data Validation Report';
    sumWs.getCell('A1').style = headerStyle;
    sumWs.getRow(1).height = 28;

    const summaryRows = [
      ['File Name',        fileName],
      ['Generated At',     Utils.formatDateTime(new Date())],
      ['Total Records',    records.length],
      ['Valid Records',    records.length - new Set(validationResult.errors.map(e=>e.row)).size],
      ['Error Count',      validationResult.errors.length],
      ['Warning Count',    validationResult.warnings.length],
      ['Status',           validationResult.isValid ? 'PASSED ✓' : 'FAILED ✗']
    ];

    summaryRows.forEach(([label, value], i) => {
      const row = sumWs.getRow(i + 2);
      row.getCell(1).value = label;
      row.getCell(2).value = value;
      row.getCell(1).font  = { bold: true };
      if (label === 'Status') {
        row.getCell(2).font = { bold: true, color: { argb: validationResult.isValid ? 'FF107C10' : 'FFA4262C' } };
      }
    });

    /* ── Errors Sheet ───────────────────────────────────────── */
    if (validationResult.errors.length) {
      const errWs = wb.addWorksheet('Errors');
      const errHeaders = ['Row', 'Field', 'Error Type', 'Message', 'Value'];
      errWs.addRow(errHeaders).eachCell(cell => {
        cell.style = { font: { bold: true, color: { argb: 'FFFFFFFF' } },
          fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFA4262C' } } };
      });
      validationResult.errors.forEach(e => {
        errWs.addRow([e.row, e.field, e.type, e.message, e.value]);
      });
      errWs.columns = [{ width: 8 },{ width: 22 },{ width: 22 },{ width: 50 },{ width: 30 }];
    }

    /* ── Warnings Sheet ─────────────────────────────────────── */
    if (validationResult.warnings.length) {
      const warnWs = wb.addWorksheet('Warnings');
      const warnHeaders = ['Row', 'Field', 'Warning Type', 'Message', 'Value'];
      warnWs.addRow(warnHeaders).eachCell(cell => {
        cell.style = { font: { bold: true, color: { argb: 'FF1B2A3A' } },
          fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFB900' } } };
      });
      validationResult.warnings.forEach(w => {
        warnWs.addRow([w.row, w.field, w.type, w.message, w.value]);
      });
      warnWs.columns = [{ width: 8 },{ width: 22 },{ width: 22 },{ width: 50 },{ width: 30 }];
    }

    /* ── All Records Sheet ──────────────────────────────────── */
    const dataWs = wb.addWorksheet('All Records');
    const dataHeaders = ['Row','Employee ID','Employee Name','Month','Year','Branch','Division','Bank Name','Account Number','IFSC','Name in Bank','Status'];
    dataWs.addRow(dataHeaders).eachCell(cell => {
      cell.style = { font: { bold: true, color: { argb: 'FFFFFFFF' } },
        fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0078D4' } } };
    });

    const errorRows = new Set(validationResult.errors.map(e => e.row));
    const warnRows  = new Set(validationResult.warnings.map(w => w.row));

    records.forEach(rec => {
      const hasErr  = errorRows.has(rec._row);
      const hasWarn = warnRows.has(rec._row) && !hasErr;
      const status  = hasErr ? 'ERROR' : hasWarn ? 'WARNING' : 'OK';
      const row     = dataWs.addRow([
        rec._row, rec.employeeId, rec.employeeName, rec.month, rec.year,
        rec.branch, rec.division, rec.bankName, rec.bankAccountNumber,
        rec.ifsc, rec.nameInBank, status
      ]);
      if (hasErr) {
        row.eachCell(c => { c.fill = { type:'pattern',pattern:'solid',fgColor:{argb:'FFFDE8E8'} }; });
      } else if (hasWarn) {
        row.eachCell(c => { c.fill = { type:'pattern',pattern:'solid',fgColor:{argb:'FFFFF8E1'} }; });
      }
    });
    dataWs.columns = [
      {width:7},{width:16},{width:28},{width:10},{width:8},
      {width:18},{width:18},{width:22},{width:20},{width:14},{width:28},{width:10}
    ];

    const buffer = await wb.xlsx.writeBuffer();
    const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Utils.downloadBlob(blob, `HR_Validation_Report_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  /* ── Export active HR records to Excel ───────────────────── */
  async function exportToExcel() {
    if (!window.ExcelJS) throw new Error('ExcelJS not loaded');
    const records = await Database.getAll('hrMaster');
    if (!records.length) throw new Error('No HR records to export');

    const wb    = new ExcelJS.Workbook();
    const ws    = wb.addWorksheet('HR Master');
    const hdrs  = ['Employee ID','Employee Name','Month','Year','Branch','Division','Bank Name','Account Number','IFSC','Name in Bank'];
    ws.addRow(hdrs).eachCell(cell => {
      cell.style = { font:{bold:true,color:{argb:'FFFFFFFF'}}, fill:{type:'pattern',pattern:'solid',fgColor:{argb:'FF0078D4'}} };
    });
    records.forEach(r => ws.addRow([
      r.employeeId, r.employeeName, r.month, r.year,
      r.branch, r.division, r.bankName, r.bankAccountNumber, r.ifsc, r.nameInBank
    ]));
    ws.columns = [{width:16},{width:28},{width:10},{width:8},{width:18},{width:18},{width:22},{width:20},{width:14},{width:28}];

    const buffer = await wb.xlsx.writeBuffer();
    const blob   = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    Utils.downloadBlob(blob, `HR_Master_Export_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  return {
    parseSheet, mapColumns, detectMissingColumns,
    validate, normalizeRecords,
    getNextVersion, getLatestVersion,
    saveVersion, restoreVersion, deleteVersion,
    search, getVersionRecords,
    generateValidationReport, exportToExcel,
    REQUIRED_COLUMNS, OPTIONAL_COLUMNS, COLUMN_MAP
  };
})();
