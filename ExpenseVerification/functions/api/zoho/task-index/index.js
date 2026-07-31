/**
 * task-index/index.js — upsert into zoho_task_index.
 *
 * Called server-to-server by the Zoho Projects Deluge onTaskEvent custom
 * function (via invokeurl) whenever a task is created, updated, or
 * commented on — not by a logged-in browser session, so auth here is a
 * shared secret header rather than the usual session cookie.
 */

export async function onRequestPost({ request, env }) {
  const secret = request.headers.get('X-Webhook-Secret');
  if (!env.ZOHO_WEBHOOK_SECRET || secret !== env.ZOHO_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const taskId = String(body.taskId || '').trim().toUpperCase();
  if (!taskId) {
    return new Response(JSON.stringify({ error: 'taskId is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  // Don't blank out a field this event's payload doesn't include — e.g. an
  // "on update" event firing without a new comment shouldn't erase an
  // Employee ID/Amount an earlier "on comment" event already found.
  const existing = await env.DB.prepare('select * from zoho_task_index where task_id = ?').bind(taskId).first();
  const pick = (key) => {
    const v = body[key];
    return (v !== undefined && v !== null && v !== '') ? String(v) : (existing?.[toSnake(key)] ?? '');
  };
  function toSnake(key) { return key.replace(/([A-Z])/g, '_$1').toLowerCase(); }

  const row = {
    task_id:          taskId,
    project_id:       pick('projectId'),
    project_name:     pick('projectName'),
    internal_task_id: pick('internalTaskId'),
    task_name:        pick('taskName'),
    task_status:      pick('taskStatus'),
    employee_id:      pick('employeeId'),
    employee_name:    pick('employeeName'),
    claim_amount:     pick('claimAmount'),
    department:       pick('department'),
    last_sync:        new Date().toISOString(),
  };

  await env.DB.prepare(
    `insert into zoho_task_index (task_id, project_id, project_name, internal_task_id, task_name, task_status, employee_id, employee_name, claim_amount, department, last_sync)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(task_id) do update set
       project_id = excluded.project_id,
       project_name = excluded.project_name,
       internal_task_id = excluded.internal_task_id,
       task_name = excluded.task_name,
       task_status = excluded.task_status,
       employee_id = excluded.employee_id,
       employee_name = excluded.employee_name,
       claim_amount = excluded.claim_amount,
       department = excluded.department,
       last_sync = excluded.last_sync`
  ).bind(
    row.task_id, row.project_id, row.project_name, row.internal_task_id,
    row.task_name, row.task_status, row.employee_id, row.employee_name,
    row.claim_amount, row.department, row.last_sync
  ).run();

  return new Response(JSON.stringify({ status: 'success', taskId }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
