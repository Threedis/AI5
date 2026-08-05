/**
 * task-extract.js — pull Employee ID / Name / Claim Amount out of the free
 * text of a Zoho task (name + description + latest comment).
 *
 * This lives server-side rather than in the Zoho Deluge function because
 * Deluge can't be executed or unit-tested from the repo — an earlier
 * Deluge implementation silently produced garbage (a 40-character slice
 * spanning three table cells) because its newline detection didn't behave
 * as assumed. Here the same logic is covered by tests in
 * scripts/test-task-extract.mjs against real portal data.
 *
 * Input text is typically a Travel Advance Request Form HTML table
 * flattened to plain text, so labels and values run together on one line:
 *   "... Employee Name Mohit   Kumar Date 6-Jul-26 Employee Code HO-0240 ..."
 * Values are therefore terminated by the *next label*, not by punctuation.
 */

// Labels that mark the start of a following field — used to know where the
// value we're reading ends, since there's no reliable delimiter.
const NEXT_LABEL_WORDS = [
  'date', 'designation', 'grade', 'project code', 'project', 'location',
  'cost center', 'cost centre', 'employee', 'emp ', 'travel', 'purpose',
  'start date', 'end of travel', 'advance amount', 'amount', 'total',
  'conveyance', 'lodging', 'boarding', 'fooding', 'misc', 'department',
];

const EMP_ID_LABELS   = ['employee code', 'employee id', 'emp code', 'emp id', 'emp no', 'employee no'];
const EMP_NAME_LABELS = ['employee name', 'emp name'];
const AMOUNT_LABELS   = ['total', 'amount', 'net pay', 'claim amount'];

function normalizeWhitespace(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

/** Every index at which `label` appears in `lower`, so later occurrences can be tried if the first is a dud. */
function allIndexesOf(lower, label) {
  const out = [];
  let from = 0;
  for (;;) {
    const i = lower.indexOf(label, from);
    if (i === -1) break;
    out.push(i);
    from = i + label.length;
  }
  return out;
}

/** Text following `label`, with any leading ":" / "-" / whitespace separators removed. */
function afterLabel(text, index, labelLength) {
  return text.slice(index + labelLength).replace(/^[\s:\-–—=.]+/, '');
}

/** Cut `rest` at whichever known next-label appears first, so a value doesn't run into the following field. */
function truncateAtNextLabel(rest, { skipWords = [] } = {}) {
  const lower = rest.toLowerCase();
  let cut = rest.length;
  for (const word of NEXT_LABEL_WORDS) {
    if (skipWords.includes(word)) continue;
    const i = lower.indexOf(word);
    // require a word boundary so "date" doesn't fire inside "Update"
    if (i > 0 && /[\s|,;]/.test(rest[i - 1] || ' ') && i < cut) cut = i;
  }
  return rest.slice(0, cut);
}

/**
 * Employee code, e.g. "RHQ-047", "HO-0240", "ETD -   012" -> "ETD-012".
 * Zoho's table cells often carry stray spaces around the separator, so the
 * letters/digits are matched separately and rejoined in canonical form.
 */
export function extractEmployeeId(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  for (const label of EMP_ID_LABELS) {
    for (const idx of allIndexesOf(lower, label)) {
      const rest = afterLabel(text, idx, label.length).slice(0, 40);
      const m = rest.match(/^([A-Za-z]{1,6})\s*[-–—/]?\s*(\d{2,6})\b/);
      if (m) return `${m[1].toUpperCase()}-${m[2]}`;
      // purely numeric codes, e.g. "Employee No: 1234"
      const numeric = rest.match(/^(\d{3,10})\b/);
      if (numeric) return numeric[1];
    }
  }
  return '';
}

/** Employee name — terminated by the next field label rather than by punctuation. */
export function extractEmployeeName(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  for (const label of EMP_NAME_LABELS) {
    for (const idx of allIndexesOf(lower, label)) {
      const rest = afterLabel(text, idx, label.length);
      // "employee"/"emp " would match the label we just consumed
      const value = normalizeWhitespace(
        truncateAtNextLabel(rest, { skipWords: ['employee', 'emp '] })
      ).slice(0, 60);
      // names are alphabetic; reject a hit that immediately ran into digits
      if (value && /^[A-Za-z][A-Za-z.\s'-]{1,}$/.test(value)) return value.trim();
    }
  }
  return '';
}

/**
 * Claim amount. Only accepts a label whose value *starts* with a number, so
 * "Advance Amount ( As per break up given below )" and "Amount in words
 * EIGHTY..." — both real headers in these forms — are correctly skipped,
 * while "Total 76,600" and "Amount -15000" are picked up.
 */
export function extractClaimAmount(text) {
  if (!text) return '';
  const lower = text.toLowerCase();
  for (const label of AMOUNT_LABELS) {
    for (const idx of allIndexesOf(lower, label)) {
      const rest = afterLabel(text, idx, label.length).replace(/^(rs\.?|inr|₹)\s*/i, '');
      const m = rest.match(/^([\d,]+(?:\.\d{1,2})?)/);
      if (!m) continue;
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) return String(n);
    }
  }
  return '';
}

export function extractTaskFields(text) {
  return {
    employeeId:   extractEmployeeId(text),
    employeeName: extractEmployeeName(text),
    claimAmount:  extractClaimAmount(text),
  };
}
