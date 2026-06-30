/**
 * utils.js — Shared utility helpers
 * Employee Expense Verification System
 */

const Utils = (() => {

  /** Format a date to locale string */
  function formatDate(date, opts = {}) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d)) return '—';
    return d.toLocaleDateString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', ...opts
    });
  }

  /** Format date + time */
  function formatDateTime(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d)) return '—';
    return d.toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    });
  }

  /** Format a number as Indian currency */
  function formatCurrency(n) {
    if (n == null || isNaN(n)) return '₹0.00';
    return new Intl.NumberFormat('en-IN', {
      style: 'currency', currency: 'INR', minimumFractionDigits: 2
    }).format(Number(n));
  }

  /** Format a large number with commas */
  function formatNumber(n) {
    return new Intl.NumberFormat('en-IN').format(Number(n) || 0);
  }

  /** Time ago from now */
  function timeAgo(date) {
    const d   = date instanceof Date ? date : new Date(date);
    const sec = Math.floor((Date.now() - d) / 1000);
    if (sec < 60)   return 'just now';
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  /** Generate a UUID v4 */
  function uuid() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
  }

  /** Deep clone an object */
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /** Debounce a function */
  function debounce(fn, ms = 300) {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  }

  /** Throttle a function */
  function throttle(fn, ms = 100) {
    let last = 0;
    return (...args) => {
      const now = Date.now();
      if (now - last >= ms) { last = now; fn(...args); }
    };
  }

  /** Sanitize a string for display (prevent XSS) */
  function escapeHtml(str) {
    const el = document.createElement('div');
    el.textContent = String(str ?? '');
    return el.innerHTML;
  }

  /** Download a Blob as a file */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1000);
  }

  /** Read a file as ArrayBuffer */
  function readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsArrayBuffer(file);
    });
  }

  /** Read a file as text */
  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = e => resolve(e.target.result);
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsText(file);
    });
  }

  /** Validate IFSC code */
  function isValidIFSC(ifsc) {
    return /^[A-Z]{4}0[A-Z0-9]{6}$/.test(String(ifsc ?? '').trim().toUpperCase());
  }

  /** Validate a bank account number (basic) */
  function isValidAccountNumber(acc) {
    const s = String(acc ?? '').trim().replace(/\s/g, '');
    return /^\d{9,18}$/.test(s);
  }

  /** Validate PAN */
  function isValidPAN(pan) {
    return /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(pan ?? '').trim().toUpperCase());
  }

  /** Get initials from a name */
  function getInitials(name) {
    return String(name ?? '').split(' ')
      .filter(Boolean).slice(0, 2)
      .map(w => w[0].toUpperCase()).join('');
  }

  /** Capitalize first letter of each word */
  function titleCase(str) {
    return String(str ?? '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  /** Normalize a string for comparison */
  function normalize(str) {
    return String(str ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  /** Sleep helper */
  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /** Format file size */
  function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  }

  /** Check if a value is empty (null / undefined / blank string) */
  function isEmpty(v) {
    if (v == null) return true;
    if (typeof v === 'string') return v.trim() === '';
    return false;
  }

  return {
    formatDate, formatDateTime, formatCurrency, formatNumber,
    timeAgo, uuid, deepClone, debounce, throttle,
    escapeHtml, downloadBlob,
    readFileAsArrayBuffer, readFileAsText,
    isValidIFSC, isValidAccountNumber, isValidPAN,
    getInitials, titleCase, normalize, sleep, formatFileSize, isEmpty
  };
})();
