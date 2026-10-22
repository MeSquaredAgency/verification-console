// A task is locked to one person while open; the lock lapses after 15 minutes idle.
import { HTTPException } from "hono/http-exception";
import { audit } from "../lib/audit";
import { now, nowIso } from "../lib/clock";
import { run } from "../lib/db";
import type { Actor, Env } from "../lib/env";
import type { TaskRow } from "../lib/repo";

export const LOCK_IDLE_MS = 15 * 60 * 1000;

function expiry(env: Env) {
  return new Date(now(env).getTime() + LOCK_IDLE_MS).toISOString();
}

export function lockHeldByOther(env: Env, task: TaskRow, actor: Actor): boolean {
  return !!task.lock_holder && task.lock_holder !== actor.email && !!task.lock_expires_at && task.lock_expires_at > nowIso(env);
}

/** Take the lock if it is free, lapsed or already ours. Throws 409 if someone else holds it. */
export async function acquireLock(env: Env, task: TaskRow, actor: Actor): Promise<void> {
  if (lockHeldByOther(env, task, actor)) throw new HTTPException(409, { message: `Open by ${task.lock_holder}` });
  const fresh = task.lock_holder !== actor.email || !task.lock_expires_at || task.lock_expires_at <= nowIso(env);
  const exp = expiry(env);
  // Conditional update so two people opening at once can't both win.
  const res = await run(
    env.DB,
    "UPDATE tasks SET lock_holder = ?, lock_expires_at = ? WHERE id = ? AND (lock_holder IS NULL OR lock_holder = ? OR lock_expires_at <= ?)",
    actor.email,
    exp,
    task.id,
    actor.email,
    nowIso(env),
  );
  if (!res.meta.changes) throw new HTTPException(409, { message: "Task was just opened by someone else" });
  task.lock_holder = actor.email;
  task.lock_expires_at = exp;
  if (fresh) await audit(env, actor.email, task.id, "lock_acquired", {});
}

export async function releaseLock(env: Env, taskId: string) {
  await run(env.DB, "UPDATE tasks SET lock_holder = NULL, lock_expires_at = NULL WHERE id = ?", taskId);
}

/** Record activity for pacing: a streak continues while gaps are under 10 minutes. */
export async function touchActivity(env: Env, actor: Actor, taskType: string | null) {
  const ts = nowIso(env);
  const gapStart = new Date(now(env).getTime() - 10 * 60 * 1000).toISOString();
  await run(
    env.DB,
    `INSERT INTO activity (email, streak_start, last_at, last_task_type) VALUES (?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       streak_start = CASE WHEN activity.last_at < ? THEN excluded.streak_start ELSE activity.streak_start END,
       last_at = excluded.last_at,
       last_task_type = COALESCE(excluded.last_task_type, activity.last_task_type)`,
    actor.email,
    ts,
    ts,
    taskType,
    gapStart,
  );
}

export function assertCanWork(task: TaskRow, actor: Actor) {
  if (actor.role === "auditor") throw new HTTPException(403, { message: "Auditors have read-only access" });
  if (task.status === "in_review" || task.status === "queued") {
    if (!["operator", "senior", "admin"].includes(actor.role)) throw new HTTPException(403, { message: "Not allowed" });
    return;
  }
  if (task.status === "second_review") {
    if (!["senior", "admin"].includes(actor.role)) throw new HTTPException(403, { message: "Waiting for a senior reviewer" });
    return;
  }
  throw new HTTPException(409, { message: `Task is ${task.status}` });
}
