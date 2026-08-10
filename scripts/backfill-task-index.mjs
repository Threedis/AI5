#!/usr/bin/env node
/**
 * backfill-task-index.mjs — populate zoho_task_index for every task in the
 * portal, so display-ID lookups hit the D1 fast path instead of the
 * ~166-project scan.
 *
 * The Zoho onTaskEvent function only indexes a task when it is created,
 * updated or commented on, so tasks untouched since those rules went live
 * have no row and still pay for the full scan. This walks the portal once
 * and indexes everything.
 *
 * What actually makes lookups fast is the ID mapping — display ID (task
 * "prefix", e.g. "CA1-T2293") to project ID + internal task ID. Employee
 * fields are a bonus: the browser re-extracts them from the live task on
 * every lookup regardless.
 *
 * ── Required environment ───────────────────────────────────────────────
 *   ZOHO_TOKEN            Zoho OAuth access token (see below)
 *   ZOHO_WEBHOOK_SECRET   same value as the Worker's ZOHO_WEBHOOK_SECRET
 *
 * ── Optional environment ───────────────────────────────────────────────
 *   ZOHO_PORTAL     portal name          (default: hbegroupprojects)
 *   ZOHO_API_BASE   Zoho REST base       (default: https://projectsapi.zoho.com/restapi)
 *   INDEX_URL       task-index endpoint  (default: https://ai5.threed.workers.dev/api/zoho/task-index)
 *
 * Getting a token: open the app, connect to Zoho, then in DevTools →
 * Application → Session Storage → the `zoho_token` entry → copy the
 * `token` field. Implicit-flow tokens last one hour, which is ample — a
 * full portal walk is one request per project page, not per task.
 *
 * ── Usage ──────────────────────────────────────────────────────────────
 *   node scripts/backfill-task-index.mjs --dry-run        # inspect, write nothing
 *   node scripts/backfill-task-index.mjs --limit 3        # try 3 projects first
 *   node scripts/backfill-task-index.mjs                  # full run
 *   node scripts/backfill-task-index.mjs --ids-only       # skip employee-field text
 *
 * --dry-run performs every read and prints what would be written without
 * sending anything. Start there, then --limit, then the full run.
 *
 * ── Working in batches ─────────────────────────────────────────────────
 * --skip pairs with --limit to cover the portal a slice at a time, which
 * matters because the token expires after an hour and the run is paced
 * against Zoho's per-minute cap:
 *
 *   node scripts/backfill-task-index.mjs --limit 10           # 1-10
 *   node scripts/backfill-task-index.mjs --skip 10 --limit 10 # 11-20
 *   node scripts/backfill-task-index.mjs --skip 20 --limit 10 # 21-30
 *
 * Each run prints the command for the next batch. Zoho returns projects
 * in a stable order, so the same slice addresses the same projects across
 * runs; re-running a batch is harmless either way, since rows are keyed
 * by display ID and simply overwritten.
 */

const TOKEN    = process.env.ZOHO_TOKEN || '';
const SECRET   = process.env.ZOHO_WEBHOOK_SECRET || '';
const PORTAL   = process.env.ZOHO_PORTAL   || 'hbegroupprojects';
const API_BASE = (process.env.ZOHO_API_BASE || 'https://projectsapi.zoho.com/restapi').replace(/\/$/, '');
const INDEX_URL = (process.env.INDEX_URL || 'https://ai5.threed.workers.dev/api/zoho/task-index').replace(/\/$/, '');

const PAGE_SIZE   = 200;  // Zoho's documented maximum for index/range paging
const CONCURRENCY = 2;    // parallel projects; the rate gate is the real control
const MAX_RETRIES = 6;

/* Zoho caps this API at 100 requests per minute and reports breaching it
   as a 400 (not a 429), so the cap has to be respected proactively —
   reacting after the fact means every in-flight request fails at once.
   The default leaves headroom for retries. */
const RATE_LIMIT = parseInt(process.env.ZOHO_RATE_LIMIT || '80', 10);
const RATE_WINDOW_MS = 60_000;

const enc = encodeURIComponent;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const opts = { dryRun: false, limit: 0, skip: 0, idsOnly: false, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--ids-only') opts.idsOnly = true;
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--limit') opts.limit = parseInt(argv[++i], 10) || 0;
    else if (a.startsWith('--limit=')) opts.limit = parseInt(a.slice(8), 10) || 0;
    else if (a === '--skip') opts.skip = parseInt(argv[++i], 10) || 0;
    else if (a.startsWith('--skip=')) opts.skip = parseInt(a.slice(7), 10) || 0;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

/* ── Outbound rate gate ─────────────────────────────────────────────────
   Sliding window over the last minute, shared by every request to Zoho.
   Requests wait their turn rather than being rejected, because a breach
   fails whatever happens to be in flight rather than queueing it. ── */
const recentRequests = [];
let gateNoticeShown = false;

async function rateGate() {
  for (;;) {
    const now = Date.now();
    while (recentRequests.length && now - recentRequests[0] > RATE_WINDOW_MS) recentRequests.shift();
    if (recentRequests.length < RATE_LIMIT) { recentRequests.push(now); return; }
    const waitMs = RATE_WINDOW_MS - (now - recentRequests[0]) + 50;
    if (!gateNoticeShown) {
      gateNoticeShown = true;
      console.log(`  (holding at ${RATE_LIMIT} requests/min — Zoho's cap is 100)`);
    }
    await sleep(waitMs);
  }
}

/* Zoho reports its per-minute cap as a 400 whose body explains the real
   reason, so status alone cannot classify it and the body must be read
   before deciding whether a failure is permanent. */
function isRateLimitBody(body) {
  return /cannot execute more than|requests per minute|rate limit|too many requests/i.test(body);
}

/* ── HTTP with retry ────────────────────────────────────────────────────
   Retries 429, 5xx, and any status whose body reveals a rate-limit
   breach. Other 4xx is permanent and returns immediately, so a bad token
   or URL fails fast instead of retrying once per project. ── */
async function requestWithRetry(url, init, label, { gated = false } = {}) {
  let delay = 1000;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    if (gated) await rateGate();

    let res;
    try {
      res = await fetch(url, init);
    } catch (e) {
      if (attempt === MAX_RETRIES) throw new Error(`${label}: ${e.message}`);
      await sleep(delay); delay *= 2;
      continue;
    }
    if (res.ok) return res;

    const body = await res.text().catch(() => '');
    const throttled = res.status === 429 || isRateLimitBody(body);

    if (throttled || res.status >= 500) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`${label}: HTTP ${res.status} after ${MAX_RETRIES} attempts ${body.slice(0, 160)}`);
      }
      const retryAfter = parseInt(res.headers.get('Retry-After') || '', 10);
      // A per-minute cap only clears when the window rolls, so short
      // exponential backoff would just burn attempts against it.
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000
                   : throttled ? RATE_WINDOW_MS / 2
                   : delay;
      await sleep(waitMs);
      delay *= 2;
      continue;
    }

    // 401 is nearly always the one-hour implicit token expiring mid-run
    // rather than anything wrong with the request, so say so plainly —
    // the raw Zoho message ("Invalid OAuth access token") reads like a
    // configuration fault.
    if (res.status === 401) {
      throw new Error(`${label}: HTTP 401 — ZOHO_TOKEN is expired or invalid. Zoho tokens last one hour; grab a fresh one and re-run.`);
    }
    throw new Error(`${label}: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  throw new Error(`${label}: exhausted retries`);
}

async function zohoGet(path, label) {
  const res = await requestWithRetry(`${API_BASE}${path}`, {
    headers: { Authorization: `Zoho-oauthtoken ${TOKEN}` },
  }, label, { gated: true });
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

/* ── Paged collection fetch ─────────────────────────────────────────────
   Zoho pages with 1-based `index` plus `range`. A short page means the
   end; an empty page also ends the walk. The hard page cap stops a
   misbehaving endpoint that always returns a full page from looping
   forever. ── */
async function fetchAllPages(buildPath, key, label) {
  const out = [];
  let index = 1;
  for (let page = 0; page < 100; page++) {
    const data = await zohoGet(buildPath(index, PAGE_SIZE), `${label} (index ${index})`);
    const items = data[key];
    if (!Array.isArray(items) || items.length === 0) break;
    out.push(...items);
    if (items.length < PAGE_SIZE) break;
    index += PAGE_SIZE;
  }
  return out;
}

async function listProjects() {
  return fetchAllPages(
    (i, r) => `/portal/${enc(PORTAL)}/projects/?index=${i}&range=${r}`,
    'projects',
    'list projects'
  );
}

/* ── Tasks from one task-collection endpoint ────────────────────────────
   Zoho's task endpoint defaults to open tasks only, and which parameter
   selects closed ones varies between API versions — so several variants
   are tried and merged, deduplicated by internal task ID. Missing closed
   tasks would silently leave exactly the completed expense claims (the
   ones most likely to be looked up) unindexed.

   Paged and unpaged forms are both attempted: some portals reject the
   index/range parameters on this endpoint outright, which would
   otherwise look identical to "project has no tasks".

   Returns { tasks, ok, errors } rather than throwing, so a project that
   genuinely has no tasks (every request answered 200 with an empty list)
   is distinguishable from one where every request errored. ── */
const TASK_VARIANTS = ['status=all', '', 'type=open_tasks', 'type=closed_tasks'];

/* Probing every variant on every project is what breaches the per-minute
   cap: 166 projects x 8 combinations is an order of magnitude more
   requests than the work needs. The first combination that answers for a
   given endpoint shape holds for the whole portal, so it is remembered
   and used alone from then on; a later failure falls back to the full
   sweep, so learning wrong is recoverable rather than fatal. */
const learnedVariant = { project: null, tasklist: null };

async function attemptVariant(basePath, label, variant, paged) {
  if (paged) {
    const suffix = variant ? `&${variant}` : '';
    return fetchAllPages(
      (i, r) => `${basePath}?index=${i}&range=${r}${suffix}`,
      'tasks',
      `${label} [${variant || 'default'}]`
    );
  }
  const data = await zohoGet(`${basePath}${variant ? `?${variant}` : ''}`, `${label} [${variant || 'default'} unpaged]`);
  return Array.isArray(data.tasks) ? data.tasks : [];
}

async function collectTasks(basePath, label, verbose, kind = 'project') {
  const byId = new Map();
  const errors = [];
  let ok = false;

  // Known-good combination first — one request instead of up to eight.
  const learned = learnedVariant[kind];
  if (learned) {
    try {
      const tasks = await attemptVariant(basePath, label, learned.variant, learned.paged);
      for (const t of tasks) {
        const id = String(t.id_string || t.id || '');
        if (id && !byId.has(id)) byId.set(id, t);
      }
      // A known-good endpoint answering empty means the collection really
      // is empty, so there is nothing for a sweep to discover. `trusted`
      // lets the caller skip its own fallback on the same reasoning.
      return { tasks: [...byId.values()], ok: true, errors, trusted: true };
    } catch (e) {
      errors.push(`learned ${learned.variant || 'default'}: ${e.message}`);
      if (verbose) console.error(`      ${label} learned variant failed, re-probing — ${e.message}`);
    }
  }

  for (const variant of TASK_VARIANTS) {
    for (const paged of [true, false]) {
      let tasks;
      try {
        tasks = await attemptVariant(basePath, label, variant, paged);
      } catch (e) {
        errors.push(`${variant || 'default'}${paged ? '' : '/unpaged'}: ${e.message}`);
        if (verbose) console.error(`      ${label} ${variant || 'default'}${paged ? '' : ' unpaged'} — ${e.message}`);
        continue;
      }

      ok = true;
      for (const t of tasks) {
        const id = String(t.id_string || t.id || '');
        if (id && !byId.has(id)) byId.set(id, t);
      }
      // Only a combination that actually returned tasks is worth
      // remembering — an empty 200 proves nothing about which parameters
      // this portal honours.
      if (tasks.length) {
        if (!learnedVariant[kind]) {
          learnedVariant[kind] = { variant, paged };
          if (verbose) console.error(`      learned ${kind} variant: ${variant || 'default'}${paged ? '' : ' unpaged'}`);
        }
        break;
      }
    }
    // status=all covers open and closed; the narrower variants add nothing.
    if (ok && variant === 'status=all' && byId.size) break;
  }

  return { tasks: [...byId.values()], ok, errors };
}

/* ── Tasks for one project ──────────────────────────────────────────────
   The project-level endpoint is not enabled on every portal — the app's
   own fetchAllTasks carries the same task-list fallback for exactly that
   reason — so when it yields nothing, walk the project's task lists and
   collect each one's tasks instead. ── */
async function listProjectTasks(projectId, verbose) {
  const projectBase = `/portal/${enc(PORTAL)}/projects/${enc(projectId)}`;

  const direct = await collectTasks(`${projectBase}/tasks/`, `tasks ${projectId}`, verbose, 'project');
  if (direct.tasks.length) return direct.tasks;

  // An empty answer from a variant already proven on this portal means the
  // project has no tasks — walking its task lists would be one wasted
  // request per project against a per-minute budget.
  if (direct.trusted) return [];

  // Fall back to task lists — also the only path that works when the
  // project-level endpoint is disabled portal-wide.
  let tasklists = [];
  let tasklistError = null;
  try {
    tasklists = await fetchAllPages(
      (i, r) => `${projectBase}/tasklists/?index=${i}&range=${r}`,
      'tasklists',
      `tasklists ${projectId}`
    );
  } catch (e) {
    tasklistError = e.message;
    if (verbose) console.error(`      tasklists ${projectId} — ${e.message}`);
  }

  const byId = new Map();
  let anyListOk = false;
  for (const tl of tasklists) {
    const tlId = String(tl.id_string || tl.id || '');
    if (!tlId) continue;
    const res = await collectTasks(`${projectBase}/tasklists/${enc(tlId)}/tasks/`, `tasks ${projectId}/tl${tlId}`, verbose, 'tasklist');
    if (res.ok) anyListOk = true;
    for (const t of res.tasks) {
      const id = String(t.id_string || t.id || '');
      if (id && !byId.has(id)) byId.set(id, t);
    }
  }
  if (byId.size) return [...byId.values()];

  // Nothing anywhere: a real empty project if some request succeeded,
  // otherwise a genuine failure whose cause must reach the operator.
  if (direct.ok || anyListOk) return [];
  const detail = [...direct.errors.slice(0, 2), tasklistError].filter(Boolean).join(' | ');
  throw new Error(`could not list tasks for project ${projectId}: ${detail || 'all request variants failed'}`);
}

/* Zoho descriptions are HTML whose table cells carry the form fields.
   Flattening without separators would join "Employee Code" to its value
   and defeat task-extract.js's label matching, so block/cell boundaries
   become spaces first. Mirrors htmlToSpacedText in zoho-integration.js. */
function htmlToPlainText(raw) {
  return String(raw || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|tr|td|th|table|ul|ol|h[1-6]|blockquote)>/gi, '$& ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildRow(task, project, idsOnly) {
  const displayId = String(task.prefix || task.key || task.task_key || '').trim().toUpperCase();
  if (!displayId) return null; // nothing to key the index on

  const row = {
    taskId:         displayId,
    projectId:      String(project.id_string || project.id || ''),
    projectName:    project.name || '',
    internalTaskId: String(task.id_string || task.id || ''),
    taskStatus:     task.status?.name || task.status || '',
  };

  // taskName/taskDescPlain are what the endpoint runs task-extract.js over.
  // Withholding them leaves employee fields to the endpoint's existing-value
  // fallback, so --ids-only cannot overwrite data an event already stored.
  if (!idsOnly) {
    row.taskName      = task.name || '';
    row.taskDescPlain = htmlToPlainText(task.description || '');
  }
  return row;
}

async function postRow(row) {
  const res = await requestWithRetry(INDEX_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Secret': SECRET },
    body: JSON.stringify(row),
  }, `index ${row.taskId}`);
  return res;
}

/* Fixed-size worker pool — bounded concurrency without pulling in a dep. */
async function pooled(items, size, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(`Usage: node scripts/backfill-task-index.mjs [options]

  --dry-run     read everything, write nothing (start here)
  --limit N     only process N projects
  --skip N      start N projects in (use with --limit to work in batches)
  --ids-only    index IDs only; leaves stored employee fields untouched
  --verbose     report per-variant task-listing failures
  --help

Environment: ZOHO_TOKEN and ZOHO_WEBHOOK_SECRET are required
             (ZOHO_WEBHOOK_SECRET is not needed with --dry-run).`);
    return 0;
  }

  if (!TOKEN) throw new Error('ZOHO_TOKEN is not set.');
  if (!SECRET && !opts.dryRun) throw new Error('ZOHO_WEBHOOK_SECRET is not set (not needed with --dry-run).');

  console.log(`portal    : ${PORTAL}`);
  console.log(`zoho api  : ${API_BASE}`);
  console.log(`index url : ${INDEX_URL}`);
  console.log(`mode      : ${opts.dryRun ? 'DRY RUN — nothing will be written' : 'LIVE'}${opts.idsOnly ? ' (ids only)' : ''}\n`);

  console.log('Listing projects…');
  const allProjects = await listProjects();
  console.log(`  ${allProjects.length} project(s) found`);

  // Zoho returns projects in a stable order, so --skip/--limit address the
  // same slice run to run — which is what makes resuming in batches work.
  const from = opts.skip;
  const to = opts.limit ? from + opts.limit : allProjects.length;
  const projects = allProjects.slice(from, to);
  if (from || opts.limit) {
    console.log(`  processing ${from + 1}-${Math.min(to, allProjects.length)} of ${allProjects.length}`);
  }
  if (!projects.length) {
    console.log('\nNothing to do — --skip is at or past the end of the list.');
    return 0;
  }

  const stats = { tasks: 0, indexed: 0, noDisplayId: 0, failedProjects: 0, failedRows: 0 };
  const startedAt = Date.now();
  let done = 0;

  await pooled(projects, CONCURRENCY, async (project) => {
    const projectId = String(project.id_string || project.id || '');
    const label = project.name || projectId;
    let tasks;
    try {
      tasks = await listProjectTasks(projectId, opts.verbose);
    } catch (e) {
      stats.failedProjects++;
      console.error(`  [${from + (++done)}/${allProjects.length}] ${label} — FAILED: ${e.message}`);
      return;
    }

    let wrote = 0;
    for (const task of tasks) {
      stats.tasks++;
      const row = buildRow(task, project, opts.idsOnly);
      if (!row) { stats.noDisplayId++; continue; }

      if (opts.dryRun) {
        stats.indexed++; wrote++;
        if (opts.verbose) console.log(`      ${row.taskId} -> ${row.internalTaskId}`);
        continue;
      }
      try {
        await postRow(row);
        stats.indexed++; wrote++;
      } catch (e) {
        stats.failedRows++;
        console.error(`      ${row.taskId} — FAILED: ${e.message}`);
      }
    }
    console.log(`  [${from + (++done)}/${allProjects.length}] ${label} — ${tasks.length} task(s), ${wrote} indexed`);
  });

  const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n${opts.dryRun ? 'Dry run' : 'Backfill'} finished in ${secs}s`);
  console.log(`  tasks seen            : ${stats.tasks}`);
  console.log(`  indexed               : ${stats.indexed}`);
  console.log(`  skipped (no display ID): ${stats.noDisplayId}`);
  console.log(`  projects failed       : ${stats.failedProjects}`);
  console.log(`  rows failed           : ${stats.failedRows}`);

  const nextFrom = Math.min(to, allProjects.length);
  if (nextFrom < allProjects.length) {
    console.log(`\nNext batch:\n  node scripts/backfill-task-index.mjs --skip ${nextFrom}${opts.limit ? ` --limit ${opts.limit}` : ''}${opts.dryRun ? ' --dry-run' : ''}`);
  }

  if (!opts.dryRun) {
    console.log('\nVerify with:');
    console.log('  npx wrangler d1 execute expenseverify --remote --command="select count(*) as rows from zoho_task_index"');
  }
  return (stats.failedProjects || stats.failedRows) ? 1 : 0;
}

// process.exit() while fetch's sockets are still closing trips a libuv
// assertion on Windows (UV_HANDLE_CLOSING in win/async.c), which buries the
// real error under a crash dump. Setting exitCode lets Node drain its
// handles and exit on its own — a second or two later, but cleanly.
main()
  .then(code => { process.exitCode = code; })
  .catch(err => { console.error(`\nError: ${err.message}`); process.exitCode = 1; });
