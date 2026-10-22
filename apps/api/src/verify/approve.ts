// Approval and release. Nothing leaves until every claim has a decision; the console performs
// the release itself, always from the stored true draft.
import { sweepNumbersAndDates, type ApproveResult, type DraftContent } from "@vc/shared";
import { HTTPException } from "hono/http-exception";
import { audit } from "../lib/audit";
import { nowIso } from "../lib/clock";
import { all, newId, run } from "../lib/db";
import type { Actor, Env } from "../lib/env";
import { clientFlags, getClaims, getClient, getDraft, type ClaimRow, type TaskRow } from "../lib/repo";
import { enqueue } from "../pipeline/run";
import { sha256Hex } from "../pipeline/source";
import { restoreCanary } from "./decisions";
import { pendingCanary } from "./edits";
import { acquireLock, assertCanWork, releaseLock } from "./lock";
import { isRekeyPending } from "./view";

/** Reasons this draft can't be approved yet. Empty means approvable. */
export function approvalBlockers(content: DraftContent, claims: ClaimRow[]): string[] {
  const reasons: string[] = [];
  const open = claims.filter((c) => c.status === "undecided");
  if (open.length) reasons.push(`${open.length} claim${open.length === 1 ? "" : "s"} still need a decision`);
  const rekey = claims.filter((c) => isRekeyPending(c) || (c.needs_rekey && c.rekey_mismatch && c.status === "confirmed"));
  if (rekey.length) reasons.push(`${rekey.length} value${rekey.length === 1 ? "" : "s"} still need re-keying`);
  const decided = claims.filter((c) => c.status !== "undecided");
  // Guard: every number or date in the final text must sit inside a decided claim.
  if (content.kind === "reply") {
    for (const t of sweepNumbersAndDates(content.reply.body)) {
      const ok = decided.some((c) => c.true_start != null && c.true_start <= t.start && c.true_end! >= t.end && ["amount", "date", "number", "reference", "phone", "abn", "bank", "commitment", "policy", "legal", "address", "email"].includes(c.type));
      if (!ok) reasons.push(`"${t.text}" in the reply isn't a decided claim`);
    }
    if (sweepNumbersAndDates(content.reply.subject).length && !decided.some((c) => c.field === "subject")) reasons.push("The subject line isn't decided");
    if (!decided.some((c) => c.field === "to")) reasons.push("The recipient isn't decided");
  } else {
    for (const [field, v] of Object.entries(content.bill)) {
      if (v == null || v === "") continue;
      if (!decided.some((c) => c.field === field)) reasons.push(`Bill field ${field} isn't a decided claim`);
    }
  }
  return reasons;
}

export async function approve(env: Env, actor: Actor, task: TaskRow): Promise<ApproveResult> {
  assertCanWork(task, actor);
  const review = task.status === "second_review";
  if (task.status === "queued") throw new HTTPException(409, { message: "Open the task first" });
  if (review) {
    if (task.operator_approved_by === actor.email) throw new HTTPException(403, { message: "Second review must be by someone else" });
    if (task.needs_licensed_reviewer && !actor.licensed_apn) throw new HTTPException(403, { message: "This needs a licensed APN reviewer" });
  }
  await acquireLock(env, task, actor);
  const draft = (await getDraft(env, task.current_draft_id))!;
  const claims = await getClaims(env, draft.id);
  const content = JSON.parse(draft.content_json) as DraftContent;

  const blockers = approvalBlockers(content, claims);
  if (review && claims.some((c) => c.status === "flagged")) blockers.push("Resolve every flagged claim: confirm or correct it");
  if (blockers.length) {
    await audit(env, actor.email, task.id, "approve_blocked", { reasons: blockers });
    return { outcome: "blocked", reasons: blockers };
  }

  // Seeded test error still in place: the operator missed it. Hold the item and show them.
  const canary = await pendingCanary(env, task.id, draft.id);
  if (canary) {
    const claim = claims.find((c) => c.id === canary.claim_id);
    await restoreCanary(env, task.id, draft.id, canary, "missed", actor.email);
    await run(env.DB, "UPDATE claims SET status = 'undecided', rekeyed = 0, rekey_mismatch = 0, updated_at = ? WHERE id = ?", nowIso(env), canary.claim_id);
    return { outcome: "held", missed: { label: claim?.label ?? canary.label, shown: canary.seeded_value, actual: canary.original_value } };
  }

  const client = (await getClient(env, task.client_id))!;
  const flags = clientFlags(client);
  const ts = nowIso(env);
  if (!review) {
    await spotCheck(env, task, actor, client.spot_check_floor_ms);
    const needsSecond = (task.tier >= 3 && flags.second_review_tier3) || claims.some((c) => c.status === "flagged") || !!task.needs_licensed_reviewer;
    if (needsSecond) {
      await run(env.DB, "UPDATE tasks SET status = 'second_review', operator_approved_by = ?, operator_approved_at = ?, updated_at = ? WHERE id = ?", actor.email, ts, ts, task.id);
      await releaseLock(env, task.id);
      await audit(env, actor.email, task.id, "approved_to_second_review", { tier: task.tier, flagged: claims.filter((c) => c.status === "flagged").length });
      return { outcome: "second_review" };
    }
    await run(env.DB, "UPDATE tasks SET operator_approved_by = ?, operator_approved_at = ? WHERE id = ?", actor.email, ts, task.id);
    task.operator_approved_by = actor.email;
  }
  const releaseId = await release(env, task, draft.id, content, review ? task.operator_approved_by! : actor.email, review ? actor.email : null);
  return { outcome: "released", release_id: releaseId };
}

/**
 * Phase 0 release writes the final output to the database and shows it. Nothing is sent or
 * posted anywhere; live sending waits on the release_send_live flag and Phase 2.
 */
export async function release(env: Env, task: TaskRow, draftId: string, content: DraftContent, approvedBy: string, secondReviewer: string | null): Promise<string> {
  // Belt and braces: the output is the stored true draft, and no seeded value may survive.
  const canaries = await all<{ seeded_value: string; original_value: string; outcome: string; label: string }>(env.DB, "SELECT * FROM canaries WHERE task_id = ? AND draft_id = ?", task.id, draftId);
  if (canaries.some((c) => c.outcome === "pending")) throw new Error("Refusing to release with a pending seeded error");
  const output = JSON.stringify(content);
  const client = (await getClient(env, task.client_id))!;
  if (clientFlags(client).release_send_live) throw new HTTPException(501, { message: "Live sending is a Phase 2 feature and is not built in Phase 0" });
  const id = newId("rl");
  const ts = nowIso(env);
  await run(
    env.DB,
    "INSERT INTO releases (id, task_id, draft_id, output_json, output_hash, destination, external_id, approved_by, second_reviewer, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    id,
    task.id,
    draftId,
    output,
    await sha256Hex(output),
    "database",
    null,
    approvedBy,
    secondReviewer,
    ts,
  );
  await run(env.DB, "UPDATE tasks SET status = 'released', lock_holder = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?", ts, task.id);
  await audit(env, secondReviewer ?? approvedBy, task.id, "released", { release_id: id, destination: "database", approved_by: approvedBy, second_reviewer: secondReviewer });
  return id;
}

/** If time per claim drops below the client's calibrated floor, add the item to the spot-check list. */
async function spotCheck(env: Env, task: TaskRow, actor: Actor, floorMs: number | null) {
  if (!floorMs) return;
  const times = (await all<{ time_ms: number }>(env.DB, "SELECT time_ms FROM decisions WHERE task_id = ? AND actor = ? AND time_ms IS NOT NULL ORDER BY time_ms", task.id, actor.email)).map((r) => r.time_ms);
  if (!times.length) return;
  const median = times[Math.floor(times.length / 2)];
  if (median < floorMs) {
    await run(env.DB, "INSERT INTO spot_checks (id, task_id, operator, reason, median_ms, created_at) VALUES (?,?,?,?,?,?)", newId("sc"), task.id, actor.email, `Median ${median} ms per claim is under the ${floorMs} ms floor`, median, nowIso(env));
    await audit(env, "system", task.id, "spot_check_added", { median_ms: median, floor_ms: floorMs });
  }
}

/** A rejected draft goes back to the pipeline to be redrafted, not patched by hand. */
export async function reject(env: Env, actor: Actor, task: TaskRow, note: string) {
  assertCanWork(task, actor);
  if (!note.trim()) throw new HTTPException(400, { message: "Say what's wrong so the redraft can fix it" });
  if (task.status !== "second_review") await acquireLock(env, task, actor);
  const ts = nowIso(env);
  await run(env.DB, "UPDATE canaries SET outcome = 'void', resolved_at = ? WHERE task_id = ? AND outcome = 'pending'", ts, task.id);
  await run(
    env.DB,
    "UPDATE tasks SET status = 'processing', redraft_note = ?, operator_approved_by = NULL, operator_approved_at = NULL, lock_holder = NULL, lock_expires_at = NULL, updated_at = ? WHERE id = ?",
    note.trim(),
    ts,
    task.id,
  );
  await audit(env, actor.email, task.id, "rejected_for_redraft", { note: note.trim() });
  await enqueue(env, task.id, "draft");
}
