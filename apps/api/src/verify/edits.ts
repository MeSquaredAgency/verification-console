// Operator edits. Any edit creates a new draft version: claims are re-extracted from the changed
// text, unchanged claims keep their decisions, new or changed claims start undecided, and the model
// is called again only to check the claims that changed.
import { BILL_FIELDS, canonical, type BillEntry, type ClaimType, type DraftContent } from "@vc/shared";
import { HTTPException } from "hono/http-exception";
import { audit } from "../lib/audit";
import { nowIso } from "../lib/clock";
import { first, parseJson, run } from "../lib/db";
import type { Actor, Env } from "../lib/env";
import { getClaims, getDraft, type ClaimRow, type TaskRow } from "../lib/repo";
import { checkCandidates, listCandidates, regroup, type PreviousChecks } from "../pipeline/claims";
import { draftTierRules, mergeTier } from "../pipeline/rules";
import { claimContext } from "../pipeline/run";
import { saveDraftVersion, type Carry } from "./drafts";

export type EditRequest =
  | { kind: "field"; field: string; value: string | null }
  | { kind: "body"; body: string }
  | { kind: "span"; start: number; end: number; text: string };

export type CanaryRow = { id: string; claim_id: string; label: string; original_value: string; seeded_value: string; outcome: string };

export async function pendingCanary(env: Env, taskId: string, draftId: string) {
  return first<CanaryRow>(env.DB, "SELECT * FROM canaries WHERE task_id = ? AND draft_id = ? AND outcome = 'pending'", taskId, draftId);
}

/** Smallest single replacement turning `a` into `b`. */
export function diff(a: string, b: string): { s: number; e: number; r: string } {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let ea = a.length;
  let eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return { s, e: ea, r: b.slice(s, eb) };
}

export async function applyEdit(
  env: Env,
  actor: Actor,
  task: TaskRow,
  req: EditRequest,
  opts: { corrected?: ClaimRow } = {},
): Promise<{ canary: "caught" | null; draftId: string }> {
  const draft = (await getDraft(env, task.current_draft_id))!;
  const oldClaims = await getClaims(env, draft.id);
  const trueC = JSON.parse(draft.content_json) as DraftContent;
  const dispC = (draft.display_json ? JSON.parse(draft.display_json) : trueC) as DraftContent;
  const canary = await pendingCanary(env, task.id, draft.id);
  const canaryClaim = canary ? oldClaims.find((c) => c.id === canary.claim_id) ?? null : null;

  let newContent: DraftContent;
  let caught = false;
  let keep = !!canary;
  let region: { start: number; end: number } | null = null;
  let editedField: string | null = null;

  if (trueC.kind === "bill") {
    if (req.kind !== "field" || !(BILL_FIELDS as readonly string[]).includes(req.field)) throw new HTTPException(400, { message: "Bill edits are per field" });
    editedField = req.field;
    let value = req.value === "" ? null : req.value;
    if (canaryClaim && canaryClaim.field === req.field) {
      if (value != null && canonical(canaryClaim.type as ClaimType, value) === canonical(canaryClaim.type as ClaimType, canary!.seeded_value)) {
        value = canary!.original_value; // never let a seeded value into the true draft
      } else {
        caught = true;
        keep = false;
      }
    }
    newContent = { kind: "bill", bill: { ...trueC.bill, [req.field]: value } as BillEntry };
  } else {
    const oldD = (dispC as Extract<DraftContent, { kind: "reply" }>).reply.body;
    const newD = req.kind === "body" ? req.body : req.kind === "span" ? oldD.slice(0, req.start) + req.text + oldD.slice(req.end) : null;
    if (newD == null) throw new HTTPException(400, { message: "Reply edits are text edits" });
    const op = diff(oldD, newD);
    const trueBody = trueC.reply.body;
    let st = op.s;
    let et = op.e;
    let r = op.r;
    if (canaryClaim && canaryClaim.start != null) {
      const cs = canaryClaim.start;
      const ce = canaryClaim.end!;
      const ts = canaryClaim.true_start!;
      const te = canaryClaim.true_end!;
      const delta = ce - cs - (te - ts);
      st = op.s <= cs ? op.s : op.s >= ce ? op.s - delta : ts;
      et = op.e <= cs ? op.e : op.e >= ce ? op.e - delta : te;
      const overlaps = op.s < ce && op.e > cs;
      if (overlaps) {
        if (r.includes(canary!.seeded_value)) r = r.replace(canary!.seeded_value, canary!.original_value);
        else {
          caught = true;
          keep = false;
        }
      }
    }
    if (st === et && r === "") throw new HTTPException(400, { message: "No change" });
    region = { start: st, end: st + r.length };
    newContent = { kind: "reply", reply: { ...trueC.reply, body: trueBody.slice(0, st) + r + trueBody.slice(et) } };
  }

  // Re-extract claims from the changed draft; re-check only what changed.
  const ctx = await claimContext(env, task);
  const previous: PreviousChecks = new Map(
    oldClaims.map((c) => [
      c.claim_key,
      { checks: parseJson(c.checks_json, []), model_verdict: c.model_verdict, source_value: c.source_value, source_span: c.source_start != null ? { start: c.source_start, end: c.source_end! } : null },
    ]),
  );
  const cands = await listCandidates(ctx, newContent);
  let built = await checkCandidates(ctx, newContent, cands, task.tier, { previous });
  if (newContent.kind === "reply") {
    const t = mergeTier({ tier: task.tier, reasons: parseJson(task.tier_reasons_json, []), licensed: !!task.needs_licensed_reviewer }, draftTierRules(built.map((b) => b.type)));
    if (t.tier > task.tier) {
      await run(env.DB, "UPDATE tasks SET tier = ?, tier_reasons_json = ? WHERE id = ?", t.tier, JSON.stringify(t.reasons), task.id);
      task.tier = t.tier;
      task.tier_reasons_json = JSON.stringify(t.reasons);
    }
    built = built.map((b) => regroup(b, task.tier));
  }

  const oldByKey = new Map(oldClaims.map((c) => [c.claim_key, c]));
  const carry = new Map<string, Carry>();
  for (const b of built) {
    const old = oldByKey.get(b.key);
    if (!old) continue;
    if (canaryClaim && old.id === canaryClaim.id && caught) continue;
    const oldDisagree = new Set(parseJson<{ check: string; result: string }[]>(old.checks_json, []).filter((k) => k.result === "disagree").map((k) => k.check));
    const newProblem = b.checks.some((k) => k.result === "disagree" && !oldDisagree.has(k.check));
    carry.set(b.key, {
      status: newProblem ? "undecided" : old.status,
      rekeyed: old.rekeyed,
      rekey_mismatch: old.rekey_mismatch,
      prev_claim_id: old.id,
    });
  }
  if (opts.corrected) {
    const c = opts.corrected;
    const target =
      newContent.kind === "bill"
        ? built.find((b) => b.field === c.field)
        : c.type === "question"
          ? built.find((b) => b.key === c.claim_key)
          : built.find((b) => b.true_start != null && region && b.true_start < Math.max(region.end, region.start + 1) && b.true_end! > region.start && b.type === c.type) ??
            built.find((b) => b.true_start != null && region && b.true_start < Math.max(region.end, region.start + 1) && b.true_end! > region.start);
    if (target) carry.set(target.key, { status: "corrected", rekeyed: 1, rekey_mismatch: 0, prev_claim_id: c.id });
  }

  const keepCanary = keep && canary && canaryClaim ? { id: canary.id, key: canaryClaim.claim_key, seeded: canary.seeded_value } : null;
  if (keepCanary && !built.some((b) => b.key === keepCanary.key)) {
    // The seeded claim no longer exists in the same form: treat as caught.
    caught = true;
  }
  const { draftId } = await saveDraftVersion(env, {
    taskId: task.id,
    version: draft.version + 1,
    content: newContent,
    author: actor.email,
    model: null,
    promptVersion: null,
    parentId: draft.id,
    claims: built,
    carry,
    keepCanary: caught ? null : keepCanary,
  });
  task.current_draft_id = draftId;
  if (caught && canary) {
    await run(env.DB, "UPDATE canaries SET outcome = 'caught', resolved_at = ?, operator = ? WHERE id = ?", nowIso(env), actor.email, canary.id);
    await audit(env, actor.email, task.id, "canary_caught", { canary_id: canary.id, label: canary.label, via: "edit" });
  }
  await audit(env, actor.email, task.id, "edit", {
    draft_id: draftId,
    from_version: draft.version,
    field: editedField,
    region,
    corrected_claim: opts.corrected?.id ?? null,
  });
  return { canary: caught ? "caught" : null, draftId };
}
