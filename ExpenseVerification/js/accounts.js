/**
 * accounts.js — Accounts Bank Advice Upload Module
 * Handles SAL / NES multi-section Excel parsing, validation, encrypted storage
 * and batch management for the Employee Expense Verification System.
 */

const Accounts = (() => {

  /* ── Column aliases for flexible detection ───────────────── */
  const COLUMN_MAP = {
    slNo:        ['sl no','slno','sl.no','sl','sno','s.no','serial','sr no','sr.no','serial no'],
    empCode:     ['emp code','empcode','emp_code','employee code','employee_code','emp id','empid',
                  'employee id','staff code','staff id','personnel no','personnel number','payroll no'],
    empName:     ['emp name','empname','emp_name','employee name','employee_name','name','staff name'],
    bankName:    ['bank name','bankname','bank_name','bank','bank nm'],
    accountNo:   ['bank ac no','bank ac','account no','account number','account_no','accountno',
                  'acc no','acc_no','ac no','acno','bank account','bank account no','bankacno'],
    netPay:      ['netpay','net pay','net_pay','net amount','net salary','amount','salary',
                  'net sal','sal amount'],
    pan:         ['pan','pan no','pan number','pan_no','pan card','pancard'],
    ifsc:        ['ifsc','ifsc code','ifsc_code','ifsc no','ifsccode','ifsc_no'],
    nameInBank:  ['name in bank','nameinbank','name_in_bank','account name','ac name',
                  'bank account name','beneficiary name'],
    department:  ['department','dept','division','dept name','department name'],
    designation: ['designation','desig','position','grade'],
    location:    ['location','branch','office','city'],
  };

  /* ── Section header keywords (HDFC, NEFT, HOLD, CHEQUE etc.) */
  const SECTION_KEYWORDS = ['hdfc', 'neft', 'hold', 'cheque', 'chq', 'others', 'other'];

  /* ── Rows to skip (totals, cancelled, nil, etc.) ─────────── */
  const SKIP_PATTERNS = [
    /\bcancelled?\b/i, /\bcanceled\b/i,
    /\btotal\b/i, /^grand total/i, /^sub.?total/i,
    /\bnil\b/i,
  ];

  /* ── Normalize a header string ───────────────────────────── */
  function norm(s) {
    return String(s ?? '').toLowerCase().replace(/[_\-\s]+/g, ' ').trim();
  }

  /* ── Map detected headers → field names ─────────────────── */
  function mapColumns(headers) {
    const map = {};
    headers.forEach((h, idx) => {
      const n = norm(h);
      for (const [field, aliases] of Object.entries(COLUMN_MAP)) {
        if (aliases.includes(n) && !(field in map)) {
          map[field] = idx;
        }
      }
    });
    return map;
  }

  /* ── Detect if a row is a named section header (HDFC/NEFT/HOLD/CHEQUE) */
  function detectSection(rawRow) {
    const allVals = rawRow.map(v => String(v ?? '').trim().toLowerCase()).filter(Boolean);
    if (allVals.length === 0) return null; // blank row, not a section header
    // A section header row has very few non-empty cells and one matches a keyword
    const nonEmpty = allVals.filter(v => v.length > 0);
    if (nonEmpty.length <= 3) {
      for (const kw of SECTION_KEYWORDS) {
        if (nonEmpty.some(v => v === kw || v.startsWith(kw + ' ') || v.endsWith(' ' + kw))) {
          return kw.toUpperCase();
        }
      }
    }
    return null;
  }

  /* ── Detect if a row should be skipped (blank / totals / etc.) */
  function shouldSkipRow(row, colMap) {
    const vals = Object.values(row).filter(v => v !== null && v !== undefined && String(v).trim() !== '');
    if (vals.length === 0) return true;

    const name    = String(row[colMap.empName]  ?? '').trim();
    const accNo   = String(row[colMap.accountNo] ?? '').trim();
    const empCode = String(row[colMap.empCode]  ?? '').trim();

    for (const pat of SKIP_PATTERNS) {
      if (pat.test(name) || pat.test(accNo)) return true;
    }

    // Skip rows missing all identity fields (e.g. sub-total or label rows between sections)
    if (!accNo && !empCode && !name) return true;

    return false;
  }

  /* ── Parse a single sheet ────────────────────────────────── */
  function parseSheet(ws, sheetName) {
    const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
    const maxRow = range.e.r;
    const maxCol = range.e.c;

    // Read all rows as arrays
    const rows = [];
    for (let r = range.s.r; r <= maxRow; r++) {
      const row = [];
      for (let c = range.s.c; c <= maxCol; c++) {
        const cell = ws[XLSX.utils.encode_cell({ r, c })];
        row.push(cell ? cell.v : null);
      }
      rows.push(row);
    }

    // Find header row (has ≥ 3 non-empty string-like cells, contains account-like column)
    let headerIdx = -1;
    let colMap = {};
    for (let i = 0; i < Math.min(20, rows.length); i++) {
      const headers = rows[i].map(v => String(v ?? ''));
      const nonEmpty = headers.filter(h => h.trim().length > 1).length;
      if (nonEmpty < 3) continue;
      const mapped = mapColumns(headers);
      // Must map at least accountNo or empCode to be a valid header
      if (mapped.accountNo !== undefined || mapped.empCode !== undefined) {
        headerIdx = i;
        colMap = mapped;
        break;
      }
    }

    if (headerIdx < 0) return { records: [], colMap: {}, found: false };

    // Parse data rows after header
    const records = [];
    let currentSection = '';
    let skipNextNonBlank = false; // set after section header to skip its column-header row

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const rawRow = rows[i];

      // Skip blank rows early
      const allCellVals = rawRow.map(v => String(v ?? '').trim()).filter(Boolean);
      if (allCellVals.length === 0) continue;

      // Check if this row is a section header (HDFC / NEFT / HOLD / CHEQUE)
      const section = detectSection(rawRow);
      if (section !== null) {
        currentSection = section;
        skipNextNonBlank = true; // the next non-blank row is the column-header for this section
        continue;
      }

      // Skip the column-header row that follows each section header
      if (skipNextNonBlank) {
        skipNextNonBlank = false;
        const rowHeaders = rawRow.map(v => String(v ?? ''));
        const reMapped = mapColumns(rowHeaders);
        // Merge: keep existing colMap entries for any field not found in reMapped
        if (Object.keys(reMapped).length >= 2) {
          colMap = { ...colMap, ...reMapped };
        }
        continue; // always skip the row immediately after a section header
      }

      // Also skip any other repeat header rows (safety net)
      const rowHeaders2 = rawRow.map(v => String(v ?? ''));
      const nonEmptyHdrs = rowHeaders2.filter(h => h.trim().length > 1).length;
      if (nonEmptyHdrs >= 3) {
        const reMapped2 = mapColumns(rowHeaders2);
        if (reMapped2.accountNo !== undefined || reMapped2.empCode !== undefined) {
          colMap = { ...colMap, ...reMapped2 };
          continue;
        }
      }

      // Build keyed object for field extraction
      const obj = {};
      rawRow.forEach((v, idx) => { obj[idx] = v; });

      if (shouldSkipRow(obj, colMap)) continue;

      // Extract fields
      const accountNo = String(obj[colMap.accountNo] ?? '').trim().replace(/[^0-9]/g, '');
      const empCode   = String(obj[colMap.empCode]   ?? '').trim();

      // Must have at least an account number or emp code
      if (!accountNo && !empCode) continue;

      const record = {
        slNo:        String(obj[colMap.slNo]        ?? '').trim(),
        empCode:     empCode.toUpperCase(),
        empName:     String(obj[colMap.empName]      ?? '').trim(),
        bankName:    String(obj[colMap.bankName]     ?? '').trim(),
        accountNo,
        netPay:      parseFloat(String(obj[colMap.netPay] ?? '0').replace(/[^0-9.\-]/g, '')) || 0,
        pan:         String(obj[colMap.pan]          ?? '').trim().toUpperCase(),
        ifsc:        String(obj[colMap.ifsc]         ?? '').trim().toUpperCase(),
        nameInBank:  String(obj[colMap.nameInBank]   ?? '').trim(),
        department:  String(obj[colMap.department]   ?? '').trim(),
        designation: String(obj[colMap.designation]  ?? '').trim(),
        location:    String(obj[colMap.location]     ?? '').trim(),
        section:     currentSection,
        isHold:      currentSection === 'HOLD',
        _sheet:      sheetName,
        _row:        i + 1,
      };

      records.push(record);
    }

    return { records, colMap, found: true };
  }

  /* ── Detect format type: SAL or NES ─────────────────────── */
  function detectFormat(workbook) {
    const name = (workbook.Props?.SheetNames?.[0] || workbook.SheetNames?.[0] || '').toLowerCase();
    if (/nes|nps|neft/i.test(name)) return 'NES';
    if (/sal|salary/i.test(name)) return 'SAL';
    // Inspect first sheet cell content
    const ws = workbook.Sheets[workbook.SheetNames[0]];
    const a1 = ws['A1'] ? String(ws['A1'].v).toLowerCase() : '';
    if (/nes|nps|neft/i.test(a1)) return 'NES';
    return 'SAL';
  }

  /* ── Parse a workbook (all sheets) ──────────────────────── */
  function parseWorkbook(workbook, fileName) {
    const format = detectFormat(workbook);
    const allRecords = [];
    const sheetResults = [];

    for (const sheetName of workbook.SheetNames) {
      const ws = workbook.Sheets[sheetName];
      if (!ws || !ws['!ref']) continue;
      const result = parseSheet(ws, sheetName);
      sheetResults.push({ sheetName, ...result });
      allRecords.push(...result.records);
    }

    return { records: allRecords, format, fileName, sheetResults };
  }

  /* ── Validate records from all files ────────────────────── */
  function validate(records) {
    const errors   = [];
    const warnings = [];
    const accMap   = new Map(); // accountNo → first row index
    const empMap   = new Map(); // empCode   → first row index

    records.forEach((rec, idx) => {
      const rowLabel = `File: ${rec._sheet}, Row ${rec._row}`;

      // Account number
      if (!rec.accountNo) {
        errors.push({ row: idx + 1, field: 'accountNo', type: 'BLANK_ACCOUNT', message: 'Account number is blank', value: '', rowLabel });
      } else if (!/^\d{9,18}$/.test(rec.accountNo)) {
        errors.push({ row: idx + 1, field: 'accountNo', type: 'INVALID_ACCOUNT', message: 'Account number must be 9–18 digits', value: rec.accountNo, rowLabel });
      } else if (accMap.has(rec.accountNo)) {
        errors.push({ row: idx + 1, field: 'accountNo', type: 'DUPLICATE_ACCOUNT', message: `Duplicate account number (first at row ${accMap.get(rec.accountNo)})`, value: rec.accountNo, rowLabel });
      } else {
        accMap.set(rec.accountNo, idx + 1);
      }

      // IFSC (optional — blank is allowed)
      if (!rec.ifsc) {
        warnings.push({ row: idx + 1, field: 'ifsc', type: 'BLANK_IFSC', message: 'IFSC code is blank', value: '', rowLabel });
      } else if (!Utils.isValidIFSC(rec.ifsc)) {
        warnings.push({ row: idx + 1, field: 'ifsc', type: 'INVALID_IFSC', message: 'Invalid IFSC format (should be AAAA0XXXXXX)', value: rec.ifsc, rowLabel });
      }

      // Employee name
      if (!rec.empName) {
        errors.push({ row: idx + 1, field: 'empName', type: 'BLANK_NAME', message: 'Employee name is blank', value: '', rowLabel });
      }

      // Net pay
      if (rec.netPay <= 0) {
        warnings.push({ row: idx + 1, field: 'netPay', type: 'ZERO_NETPAY', message: 'Net pay is zero or negative', value: rec.netPay, rowLabel });
      }

      // PAN (optional but validate format if present)
      if (rec.pan && !Utils.isValidPAN(rec.pan)) {
        warnings.push({ row: idx + 1, field: 'pan', type: 'INVALID_PAN', message: 'PAN format appears invalid', value: rec.pan, rowLabel });
      }

      // Name in bank (optional)
      if (!rec.nameInBank) {
        warnings.push({ row: idx + 1, field: 'nameInBank', type: 'MISSING_NAME_IN_BANK', message: 'Name in bank not provided', value: '', rowLabel });
      }

      // Bank name (optional)
      if (!rec.bankName) {
        warnings.push({ row: idx + 1, field: 'bankName', type: 'MISSING_BANK_NAME', message: 'Bank name not provided', value: '', rowLabel });
      }

      // HOLD section — payment is pending release
      if (rec.isHold) {
        warnings.push({ row: idx + 1, field: 'section', type: 'PAYMENT_ON_HOLD', message: 'Employee payment is in HOLD section — release is pending', value: rec.empName || rec.empCode, rowLabel });
      }
    });

    return {
      errors,
      warnings,
      isValid: errors.length === 0,
      total: records.length,
    };
  }

  /* ── Normalize records before saving ────────────────────── */
  function normalizeRecords(records, batchId) {
    return records.map(rec => ({
      ...rec,
      id:         Utils.uuid(),
      batchId,
      empCode:    rec.empCode.toUpperCase(),
      ifsc:       rec.ifsc.toUpperCase(),
      pan:        rec.pan.toUpperCase(),
      empName:    Utils.titleCase(rec.empName),
      nameInBank: rec.nameInBank ? Utils.titleCase(rec.nameInBank) : '',
      bankName:   rec.bankName ? Utils.titleCase(rec.bankName) : '',
      createdAt:  new Date().toISOString(),
    }));
  }

  /* ── Get next batch number ───────────────────────────────── */
  async function getNextBatchNo() {
    const all = await Database.getAll('accountsBatches');
    if (!all.length) return 1;
    return Math.max(...all.map(b => b.batchNo || 0)) + 1;
  }

  /* ── Save a batch to IndexedDB (encrypted) ───────────────── */
  async function saveBatch(records, { fileNames, uploadedBy, validationSummary }) {
    const batchId  = Utils.uuid();
    const batchNo  = await getNextBatchNo();
    const now      = new Date().toISOString();

    const normalized = normalizeRecords(records, batchId);

    // Encrypt records
    const encRecords = await Encryption.encryptWithAppKey(normalized);

    const batch = {
      id:                batchId,
      batchNo,
      fileNames,
      uploadedBy,
      uploadedAt:        now,
      recordCount:       normalized.length,
      validationSummary,
      encryptedRecords:  encRecords,
      isActive:          true,
    };

    // Deactivate previous active batches
    const existingBatches = await Database.getAll('accountsBatches');
    for (const b of existingBatches) {
      if (b.isActive) {
        b.isActive = false;
        await Database.put('accountsBatches', b);
      }
    }

    // Clear accountsMaster and load new
    await Database.clear('accountsMaster');
    await Database.bulkPut('accountsMaster', normalized);

    // Save batch
    await Database.put('accountsBatches', batch);

    await Audit.log({
      module: 'Accounts',
      action: 'BatchSaved',
      status: 'success',
      detail: `Batch #${batchNo}: ${normalized.length} records from ${fileNames.join(', ')}`,
    });

    return { batchId, batchNo };
  }

  /* ── Restore a batch ─────────────────────────────────────── */
  async function restoreBatch(batchId) {
    const batch = await Database.get('accountsBatches', batchId);
    if (!batch) throw new Error('Batch not found');

    const records = await Encryption.decryptWithAppKey(batch.encryptedRecords);

    // Deactivate all, activate this
    const all = await Database.getAll('accountsBatches');
    for (const b of all) {
      b.isActive = (b.id === batchId);
      await Database.put('accountsBatches', b);
    }

    await Database.clear('accountsMaster');
    await Database.bulkPut('accountsMaster', records);

    await Audit.log({
      module: 'Accounts',
      action: 'BatchRestored',
      status: 'success',
      detail: `Batch #${batch.batchNo} (${batch.recordCount} records) restored`,
    });

    return { batchNo: batch.batchNo, recordCount: records.length };
  }

  /* ── Delete a batch (cannot delete active) ───────────────── */
  async function deleteBatch(batchId) {
    const batch = await Database.get('accountsBatches', batchId);
    if (!batch) throw new Error('Batch not found');
    if (batch.isActive) throw new Error('Cannot delete the active batch. Restore another batch first.');
    await Database.remove('accountsBatches', batchId);
    await Audit.log({
      module: 'Accounts',
      action: 'BatchDeleted',
      status: 'success',
      detail: `Batch #${batch.batchNo} deleted`,
    });
  }

  /* ── Generate validation report (ExcelJS) ────────────────── */
  async function generateValidationReport(parseResults, validation) {
    const wb = new ExcelJS.Workbook();
    wb.creator = 'ExpenseVerify';
    wb.created = new Date();

    const hdrStyle = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0078D4' } }, alignment: { horizontal: 'center' }, border: { bottom: { style: 'medium' } } };
    const errStyle = { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDE7E7' } } };
    const wrnStyle = { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF4CE' } } };
    const okStyle  = { fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDFF6DD' } } };

    /* Summary sheet */
    const sum = wb.addWorksheet('Summary');
    sum.columns = [{ width: 32 }, { width: 20 }];
    sum.addRow(['Accounts Validation Report']).font = { bold: true, size: 14, color: { argb: 'FF0078D4' } };
    sum.addRow(['Generated', new Date().toLocaleString()]);
    sum.addRow([]);

    const files = parseResults.map(r => r.fileName).join(', ');
    [
      ['Files Processed', files],
      ['Total Records',   validation.total],
      ['Errors',          validation.errors.length],
      ['Warnings',        validation.warnings.length],
      ['Status',          validation.isValid ? 'PASS — Ready to Save' : 'FAIL — Fix Errors Before Saving'],
    ].forEach(([k, v]) => {
      const row = sum.addRow([k, v]);
      if (k === 'Status') row.getCell(2).font = { bold: true, color: { argb: validation.isValid ? 'FF107C10' : 'FFA4262C' } };
    });

    /* Errors sheet */
    if (validation.errors.length) {
      const es = wb.addWorksheet('Errors');
      es.columns = [
        { header: 'Row',     key: 'row',     width: 8 },
        { header: 'Source',  key: 'rowLabel',width: 28 },
        { header: 'Field',   key: 'field',   width: 16 },
        { header: 'Type',    key: 'type',    width: 22 },
        { header: 'Message', key: 'message', width: 40 },
        { header: 'Value',   key: 'value',   width: 24 },
      ];
      es.getRow(1).eachCell(c => Object.assign(c, hdrStyle));
      validation.errors.forEach(e => {
        const r = es.addRow(e);
        r.eachCell(c => Object.assign(c, errStyle));
      });
    }

    /* Warnings sheet */
    if (validation.warnings.length) {
      const ws2 = wb.addWorksheet('Warnings');
      ws2.columns = [
        { header: 'Row',     key: 'row',     width: 8 },
        { header: 'Source',  key: 'rowLabel',width: 28 },
        { header: 'Field',   key: 'field',   width: 16 },
        { header: 'Type',    key: 'type',    width: 22 },
        { header: 'Message', key: 'message', width: 40 },
        { header: 'Value',   key: 'value',   width: 24 },
      ];
      ws2.getRow(1).eachCell(c => Object.assign(c, hdrStyle));
      validation.warnings.forEach(w => {
        const r = ws2.addRow(w);
        r.eachCell(c => Object.assign(c, wrnStyle));
      });
    }

    /* All Records sheet */
    const all = parseResults.flatMap(r => r.records);
    const ar = wb.addWorksheet('All Records');
    ar.columns = [
      { header: 'Sl',          key: 'slNo',        width: 8  },
      { header: 'Emp Code',    key: 'empCode',      width: 14 },
      { header: 'Emp Name',    key: 'empName',      width: 28 },
      { header: 'Bank',        key: 'bankName',     width: 20 },
      { header: 'Account No',  key: 'accountNo',    width: 22 },
      { header: 'Net Pay',     key: 'netPay',       width: 14 },
      { header: 'IFSC',        key: 'ifsc',         width: 16 },
      { header: 'PAN',         key: 'pan',          width: 14 },
      { header: 'Name in Bank',key: 'nameInBank',   width: 28 },
      { header: 'Department',  key: 'department',   width: 18 },
      { header: 'Section',     key: 'section',      width: 12 },
      { header: 'Sheet',       key: '_sheet',       width: 16 },
      { header: 'Source Row',  key: '_row',         width: 10 },
    ];
    ar.getRow(1).eachCell(c => Object.assign(c, hdrStyle));

    const errRows = new Set(validation.errors.map(e => e.row));
    const wrnRows = new Set(validation.warnings.map(w => w.row));
    all.forEach((rec, idx) => {
      const r = ar.addRow(rec);
      const n = idx + 1;
      if (errRows.has(n))       r.eachCell(c => Object.assign(c, errStyle));
      else if (wrnRows.has(n))  r.eachCell(c => Object.assign(c, wrnStyle));
      else                      r.eachCell(c => Object.assign(c, okStyle));
    });

    const buf = await wb.xlsx.writeBuffer();
    Utils.downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `Accounts_Validation_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  /* ── Export active accountsMaster to Excel ───────────────── */
  async function exportToExcel() {
    const records = await Database.getAll('accountsMaster');
    if (!records.length) throw new Error('No records to export');

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Accounts Master');
    ws.columns = [
      { header: 'Sl',          key: 'slNo',        width: 8  },
      { header: 'Emp Code',    key: 'empCode',      width: 14 },
      { header: 'Emp Name',    key: 'empName',      width: 28 },
      { header: 'Bank',        key: 'bankName',     width: 20 },
      { header: 'Account No',  key: 'accountNo',    width: 22 },
      { header: 'Net Pay',     key: 'netPay',       width: 14 },
      { header: 'IFSC',        key: 'ifsc',         width: 16 },
      { header: 'PAN',         key: 'pan',          width: 14 },
      { header: 'Name in Bank',key: 'nameInBank',   width: 28 },
      { header: 'Department',  key: 'department',   width: 18 },
    ];
    const hdrStyle = { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF038387' } } };
    ws.getRow(1).eachCell(c => Object.assign(c, hdrStyle));
    records.forEach(r => ws.addRow(r));
    const buf = await wb.xlsx.writeBuffer();
    Utils.downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      `Accounts_Master_${new Date().toISOString().slice(0,10)}.xlsx`);
  }

  return {
    parseWorkbook,
    validate,
    saveBatch,
    restoreBatch,
    deleteBatch,
    generateValidationReport,
    exportToExcel,
  };

})();
