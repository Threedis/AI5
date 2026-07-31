/**
 * task-index/[taskId].js — look up a Zoho task by its display ID
 * (e.g. "CA1-T2293") from the D1-backed index that Zoho Projects keeps
 * in sync via onTaskEvent, instead of scanning every project live.
 */
import { requireUser } from '../../_lib/auth.js';

export async function onRequestGet({ request, env, params }) {
  const { error } = await requireUser(request, env);
  if (error) return error;

  const taskId = String(params.taskId || '').trim().toUpperCase();
  if (!taskId) {
    return new Response(JSON.stringify({ error: 'taskId is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  const row = await env.DB.prepare('select * from zoho_task_index where task_id = ?').bind(taskId).first();
  if (!row) {
    return new Response(JSON.stringify({ status: 'error', message: `Task not found in index: ${taskId}` }), { status: 404, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({
    status:         'success',
    taskId:         row.task_id,
    projectId:      row.project_id,
    projectName:    row.project_name,
    internalTaskId: row.internal_task_id,
    taskName:       row.task_name,
    taskStatus:     row.task_status,
    employeeId:     row.employee_id,
    employeeName:   row.employee_name,
    claimAmount:    row.claim_amount,
    department:     row.department,
    lastSync:       row.last_sync,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
