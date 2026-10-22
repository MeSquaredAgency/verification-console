// Confirm, Correct, Flag and Re-key. Decisions are idempotent on a client-generated id, so a
// decision retried after a dropped connection is recorded once.
import { normaliseAbn, parseDate, parseMoney, centsToDecimal, sameValue, type ClaimType, type DecisionAction } from "@vc/shared";
import { HTTPException } from "hono/http-exception";
import { audit } from "../lib/audit";
import { now, nowIso } from "../lib/clock";
import { first, run, stmt } from "../lib/db";
import type { Actor, Env } from "../lib/env";
import { getDraft, type ClaimRow, type TaskRow } from "../lib/repo";
import { applyEdit, pendingCanary, type CanaryRow, type EditRequest } from "./edits";
import { acquireLock, assertCanWork, touchActivity } from "./lock";
import { isRekeyPending } from "./view";

export type DecisionInput = {
  id: string;
  claim_id: string;
  action: DecisionAction;
  value?: string | null;
  note?: string | null;
  time_ms?: number | null;
};

/** Drop the seeded value: the operator now sees the true draft. */
export async function restoreCanary(env: Env, taskId: string, draftId: string, canary: CanaryRow, outcome: "caught" | "missed", actor: string) {
  await env.DB.batch([
    stmt(env.DB, "UPDATE drafts SET display_json = NULL WHERE id = ?", draftId),
    stmt(env.DB, "UPDATE claims SET value_display = value_true, start = true_start, end = true_end WHERE draft_id = ?", draftId),
    stmt(env.DB, "UPDATE canaries SET outcome = ?, resolved_at = ?, operator = ? WHERE id = ?", outcome, nowIso(env), actor, canary.id),
  ]);
  await audit(env, actor, taskId, `canary_${outcome}`, { canary_id: canary.id, label: canary.label });
}

/** Normalise a typed correction for a bill field. */
function billValue(type: ClaimType, value: string): string {
  if (type === "amount") {
    const c = parseMoney(value);
    return c == null ? value : centsToDecimal(c);
  }
  if (type === "date") return parseDate(value)?.iso ?? value;
  if (type === "abn") {
    const d = normaliseAbn(value);
    return d.length === 11 ? `${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5, 8)} ${d.slice(8)}` : value;
  }
  return value.trim();
}

export async function decide(env: Env, actor: Actor, task: TaskRow, input: DecisionInput): Promise<{ outcome: string; canary: "caught" | null }> {
  const dup = await first<{ outcome: string | null }>(env.DB, "SELECT outcome FROM decisions WHERE id = ?", input.id);
  if (dup) return { outcome: dup.outcome ?? "duplicate", canary: null };

  assertCanWork(task, actor);
  const review = task.status === "second_review";
  if (review) {
    if (task.operator_approved_by === actor.email) throw new HTTPException(403, { message: "Second review must be by someone else" });
    if (task.needs_licensed_reviewer && !actor.licensed_apn) throw new HTTPException(403, { message: "This needs a licensed APN reviewer" });
    if (input.action === "flag") throw new HTTPException(400, { message: "In second review, correct the claim or reject for redraft" });
  }
  await acquireLock(env, task, actor);
  if (task.status === "queued") {
    await run(env.DB, "UPDATE tasks SET status = 'in_review', updated_at = ? WHERE id = ?", nowIso(env), task.id);
    task.status = "in_review";
  }

  const claim = await first<ClaimRow>(env.DB, "SELECT * FROM claims WHERE id = ?", input.claim_id);
  if (!claim || claim.task_id !== task.id) throw new HTTPException(404, { message: "Claim not found" });
  if (claim.draft_id !== task.current_draft_id) throw new HTTPException(409, { message: "The draft changed; this claim was replaced" });
  const type = claim.type as ClaimType;
  const refYear = now(env).getUTCFullYear();
  const canary = await pendingCanary(env, task.id, claim.draft_id);
  const isCanary = canary?.claim_id === claim.id;
  const ts = nowIso(env);
  let outcome = input.action as string;
  let caught: "caught" | null = null;
  const note = input.note?.trim() || null;
  const value = input.value ?? null;

  switch (input.action) {
    case "rekey": {
      if (!claim.needs_rekey) throw new HTTPException(400, { message: "This claim doesn't need re-keying" });
      if (!value?.trim()) throw new HTTPException(400, { message: "Type the value from the source" });
      if (sameValue(type, value, claim.value_display, refYear)) {
        await run(env.DB, "UPDATE claims SET rekeyed = 1, rekey_mismatch = 0, status = 'confirmed', updated_at = ? WHERE id = ?", ts, claim.id);
        outcome = "match";
      } else {
        await run(env.DB, "UPDATE claims SET rekey_mismatch = 1, status = 'undecided', updated_at = ? WHERE id = ?", ts, claim.id);
        outcome = "mismatch";
        if (isCanary && !sameValue(type, value, canary!.seeded_value, refYear)) {
          await restoreCanary(env, task.id, claim.draft_id, canary!, "caught", actor.email);
          caught = "caught";
          outcome = "canary_caught";
          if (sameValue(type, value, claim.value_true, refYear)) {
            await run(env.DB, "UPDATE claims SET rekeyed = 1, rekey_mismatch = 0, status = 'confirmed', updated_at = ? WHERE id = ?", ts, claim.id);
          }
        }
      }
      break;
    }
    case "confirm": {
      if (isRekeyPending(claim)) throw new HTTPException(400, { message: "Type the value from the source first" });
      if (claim.rekey_mismatch && !claim.rekeyed) throw new HTTPException(400, { message: "Your typed value didn't match: correct or flag it" });
      if ((claim.group_name === "unsupported" || claim.group_name === "omitted") && !note) {
        throw new HTTPException(400, { message: "Add a note saying why this is OK to leave as it is" });
      }
      await run(env.DB, "UPDATE claims SET status = 'confirmed', updated_at = ? WHERE id = ?", ts, claim.id);
      break;
    }
    case "flag": {
      if (!note) throw new HTTPException(400, { message: "Add a note for the senior reviewer" });
      if (isCanary) {
        await restoreCanary(env, task.id, claim.draft_id, canary!, "caught", actor.email);
        caught = "caught";
        outcome = "canary_caught";
        await run(env.DB, "UPDATE claims SET status = 'undecided', updated_at = ? WHERE id = ?", ts, claim.id);
      } else {
        await run(env.DB, "UPDATE claims SET status = 'flagged', updated_at = ? WHERE id = ?", ts, claim.id);
      }
      break;
    }
    case "correct": {
      if (value == null) throw new HTTPException(400, { message: "Enter the corrected value" });
      const draft = (await getDraft(env, claim.draft_id))!;
      const display = JSON.parse(draft.display_json ?? draft.content_json);
      let req: EditRequest;
      if (claim.field && display.kind === "bill") {
        req = { kind: "field", field: claim.field, value: billValue(type, value) };
      } else if (type === "question") {
        if (!value.trim()) throw new HTTPException(400, { message: "Write the answer to add to the draft" });
        const body: string = display.reply.body;
        const at = body.lastIndexOf("Kind regards");
        const pos = at >= 0 ? at : body.length;
        req = { kind: "span", start: pos, end: pos, text: `${value.trim()}\n\n` };
      } else if (claim.start != null && claim.end != null) {
        req = { kind: "span", start: claim.start, end: claim.end, text: value };
      } else {
        throw new HTTPException(400, { message: "This claim is set by the system and can't be edited" });
      }
      const res = await applyEdit(env, actor, task, req, { corrected: claim });
      caught = res.canary;
      if (caught) outcome = "canary_caught";
      break;
    }
  }

  await run(
    env.DB,
    "INSERT INTO decisions (id, task_id, claim_id, actor, role, action, value, note, outcome, time_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    input.id,
    task.id,
    claim.id,
    actor.email,
    review ? "senior" : actor.role,
    input.action,
    value,
    note,
    outcome,
    input.time_ms ?? null,
    ts,
  );
  await touchActivity(env, actor, task.type);
  await audit(env, actor.email, task.id, "decision", { decision_id: input.id, claim_id: claim.id, label: claim.label, action: input.action, outcome, source_span: [claim.source_start, claim.source_end] });
  return { outcome, canary: caught };
}
