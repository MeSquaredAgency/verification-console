import { nowIso } from "./clock";
import { run, stmt } from "./db";
import type { Env } from "./env";

/** Append to the audit log. The table rejects UPDATE and DELETE. */
export async function audit(env: Env, actor: string, taskId: string | null, event: string, detail: Record<string, unknown> = {}) {
  await run(env.DB, "INSERT INTO audit_events (ts, actor, task_id, event, detail_json) VALUES (?, ?, ?, ?, ?)", nowIso(env), actor, taskId, event, JSON.stringify(detail));
}

export function auditStmt(env: Env, actor: string, taskId: string | null, event: string, detail: Record<string, unknown> = {}) {
  return stmt(env.DB, "INSERT INTO audit_events (ts, actor, task_id, event, detail_json) VALUES (?, ?, ?, ?, ?)", nowIso(env), actor, taskId, event, JSON.stringify(detail));
}
