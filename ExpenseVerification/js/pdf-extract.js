/**
 * pdf-extract.js — PDF.js based text extraction and Zoho approval parsing
 * Extracts employee IDs, approval status, and approval metadata from
 * Zoho Task Approval PDF documents.
 */

const PDFExtract = (() => {

  /* ── Ensure PDF.js worker is configured ─────────────────── */
  function ensureWorker() {
    if (window.pdfjsLib && !pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    }
  }

  /* ── Extract full text from a PDF file ──────────────────── */
  async function extractText(file, onProgress) {
    ensureWorker();
    if (!window.pdfjsLib) throw new Error('PDF.js library not loaded');

    const buf  = await Utils.readFileAsArrayBuffer(file);
    const pdf  = await pdfjsLib.getDocument({ data: buf }).promise;
    const pages = pdf.numPages;
    let   text  = '';

    for (let i = 1; i <= pages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ');
      text += pageText + '\n';
      if (onProgress) onProgress(Math.round((i / pages) * 100), i, pages);
    }

    return { text, pageCount: pages };
  }

  /* ── Employee ID patterns ────────────────────────────────── */
  const EMP_PATTERNS = [
    /\bEMP[-_/]?\d{3,8}\b/gi,
    /\bE[-_]?\d{4,8}\b/gi,
    /\bSTAFF[-_]?\d{3,8}\b/gi,
    /\bP[-_]?\d{4,8}\b/gi,      // Payroll numbers
    /\b\d{4,8}\/\d{2,4}\b/g,    // Indian format: 1234/24
  ];

  /* ── Extract employee IDs from text ──────────────────────── */
  function extractEmpIds(text) {
    const ids = new Set();
    for (const pat of EMP_PATTERNS) {
      const matches = text.matchAll(new RegExp(pat.source, pat.flags));
      for (const m of matches) {
        ids.add(m[0].trim().toUpperCase());
      }
    }
    return [...ids];
  }

  /* ── Approval keyword detection ──────────────────────────── */
  const APPROVAL_KEYWORDS = {
    approved: [
      /\bapproved\b/i, /\bapproval\s+granted\b/i, /\bauthorized\b/i,
      /\bcleared\b/i,  /\bverified\s+and\s+approved\b/i,
      /status\s*:\s*approved/i, /task\s+status\s*:\s*approved/i,
    ],
    rejected: [
      /\brejected\b/i, /\bdenied\b/i, /\bdisapproved\b/i,
      /status\s*:\s*rejected/i, /\bnot\s+approved\b/i,
    ],
    pending: [
      /\bpending\b/i, /\bunder\s+review\b/i, /\bin\s+progress\b/i,
      /status\s*:\s*pending/i, /\bawaiting\b/i,
    ],
  };

  /* ── Detect approval status from text ────────────────────── */
  function detectApprovalStatus(text) {
    for (const [status, patterns] of Object.entries(APPROVAL_KEYWORDS)) {
      for (const pat of patterns) {
        if (pat.test(text)) return status;
      }
    }
    return 'unknown';
  }

  /* ── Extract dates from text ─────────────────────────────── */
  function extractDates(text) {
    const patterns = [
      /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}/g,   // 01/01/2024
      /\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}/g,      // 2024-01-01
      /\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}/gi,
    ];
    const dates = new Set();
    for (const pat of patterns) {
      for (const m of text.matchAll(pat)) dates.add(m[0]);
    }
    return [...dates].slice(0, 5);
  }

  /* ── Extract approver names from common patterns ─────────── */
  function extractApprovers(text) {
    const patterns = [
      /approved\s+by\s*:?\s*([A-Za-z\s\.]{3,40})/gi,
      /authorised\s+by\s*:?\s*([A-Za-z\s\.]{3,40})/gi,
      /authorized\s+by\s*:?\s*([A-Za-z\s\.]{3,40})/gi,
      /manager\s*:?\s*([A-Za-z\s\.]{3,40})/gi,
      /approver\s*:?\s*([A-Za-z\s\.]{3,40})/gi,
    ];
    const names = new Set();
    for (const pat of patterns) {
      for (const m of text.matchAll(pat)) {
        const name = m[1].trim().replace(/\s+/g, ' ');
        if (name.length >= 3 && name.length <= 40) names.add(Utils.titleCase(name));
      }
    }
    return [...names].slice(0, 5);
  }

  /* ── Extract amount/total from PDF ──────────────────────── */
  function extractAmounts(text) {
    const patterns = [
      /(?:total|amount|net\s+pay|salary)\s*:?\s*(?:rs\.?|inr|₹)?\s*([\d,]+(?:\.\d{1,2})?)/gi,
      /(?:rs\.?|inr|₹)\s*([\d,]+(?:\.\d{1,2})?)/gi,
    ];
    const amounts = [];
    for (const pat of patterns) {
      for (const m of text.matchAll(pat)) {
        const val = parseFloat(m[1].replace(/,/g, ''));
        if (!isNaN(val) && val > 0) amounts.push(val);
      }
    }
    return [...new Set(amounts)].slice(0, 5);
  }

  /* ── Full parse of a Zoho approval PDF ──────────────────── */
  async function parseApprovalPDF(file, onProgress) {
    const { text, pageCount } = await extractText(file, onProgress);

    const empIds         = extractEmpIds(text);
    const approvalStatus = detectApprovalStatus(text);
    const dates          = extractDates(text);
    const approvers      = extractApprovers(text);
    const amounts        = extractAmounts(text);

    // Extract task/reference number
    const taskMatch = text.match(/task\s*(?:no|number|id|#)\s*:?\s*([A-Z0-9\-]+)/i);
    const taskNo    = taskMatch ? taskMatch[1].trim() : null;

    // Extract department/division
    const deptMatch = text.match(/(?:department|division|dept)\s*:?\s*([A-Za-z\s&\-]{3,40})/i);
    const department = deptMatch ? deptMatch[1].trim() : null;

    const result = {
      fileName:       file.name,
      fileSize:       file.size,
      pageCount,
      extractedAt:    new Date().toISOString(),
      approvalStatus,
      empIds,
      taskNo,
      department,
      dates,
      approvers,
      amounts,
      rawText:        text,
      textLength:     text.length,
    };

    await Audit.log({
      module: 'PDF',
      action: 'Extract',
      status: 'success',
      detail: `${file.name}: ${pageCount} page(s), status=${approvalStatus}, ${empIds.length} emp IDs`,
    });

    return result;
  }

  /* ── Get a short summary string for display ──────────────── */
  function getSummary(parsed) {
    const parts = [];
    if (parsed.approvalStatus !== 'unknown') parts.push(`Status: ${Utils.titleCase(parsed.approvalStatus)}`);
    if (parsed.taskNo)     parts.push(`Task: ${parsed.taskNo}`);
    if (parsed.department) parts.push(`Dept: ${parsed.department}`);
    if (parsed.empIds.length) parts.push(`${parsed.empIds.length} emp ID(s) found`);
    if (parsed.approvers.length) parts.push(`Approver: ${parsed.approvers[0]}`);
    return parts.join(' · ') || 'PDF parsed — no structured data detected';
  }

  return {
    extractText,
    parseApprovalPDF,
    getSummary,
  };
})();
