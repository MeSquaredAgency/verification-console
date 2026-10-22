// What the verification screen receives. Values awaiting re-key are never sent to the browser.
import type { Check, ClaimGroup, ClaimStatus, ClaimType, ClaimView, DraftContent, PdfPage, TaskView } from "@vc/shared";
import { signFileUrl } from "../lib/auth";
import { nowIso } from "../lib/clock";
import { all, first, parseJson } from "../lib/db";
import type { Actor, Env } from "../lib/env";
import { clientFlags, getClaims, getClient, getDraft, getFacts, getReference, getSource, taskTierReasons, type ClaimRow, type TaskRow } from "../lib/repo";
import { findSupplier, findTenancy } from "../pipeline/rules";
import type { EmailMeta } from "../pipeline/source";

export function isRekeyPending(c: Pick<ClaimRow, "needs_rekey" | "rekeyed" | "rekey_mismatch" | "status">): boolean {
  return !!c.needs_rekey && !c.rekeyed && !c.rekey_mismatch && c.status !== "corrected";
}

function maskText(s: string): string {
  return s.replace(/\S/g, "•");
}

/** The displayed draft with re-key-pending values removed. Masking keeps character positions. */
export function maskedContent(content: DraftContent, claims: ClaimRow[]): { content: DraftContent; spans: { start: number; end: number }[] } {
  const pending = claims.filter(isRekeyPending);
  if (content.kind === "bill") {
    const bill = { ...content.bill };
    for (const c of pending) if (c.field) (bill as Record<string, string | null>)[c.field] = null;
    return { content: { kind: "bill", bill }, spans: [] };
  }
  let body = content.reply.body;
  const spans: { start: number; end: number }[] = [];
  for (const c of pending) {
    if (c.start == null || c.end == null) continue;
    body = body.slice(0, c.start) + maskText(body.slice(c.start, c.end)) + body.slice(c.end);
    spans.push({ start: c.start, end: c.end });
  }
  return { content: { kind: "reply", reply: { ...content.reply, body } }, spans };
}

type DecisionRow = { claim_id: string; action: string; actor: string; created_at: string; note: string | null };

export function claimView(c: ClaimRow, decisions: Map<string, DecisionRow>, byId: Map<string, ClaimRow>): ClaimView {
  const pending = isRekeyPending(c);
  let last: DecisionRow | undefined;
  for (let cur: ClaimRow | undefined = c; cur && !last; cur = cur.prev_claim_id ? byId.get(cur.prev_claim_id) : undefined) last = decisions.get(cur.id);
  return {
    id: c.id,
    type: c.type as ClaimType,
    label: c.label,
    field: c.field,
    group: c.group_name as ClaimGroup,
    status: c.status as ClaimStatus,
    needs_rekey: !!c.needs_rekey,
    rekey_pending: pending,
    rekey_mismatch: !!c.rekey_mismatch,
    draft_value: pending ? null : c.value_display,
    source_value: pending ? null : c.source_value,
    draft_span: c.start != null && c.end != null ? { start: c.start, end: c.end } : null,
    source_span: c.source_start != null && c.source_end != null ? { start: c.source_start, end: c.source_end } : null,
    // While a re-key is pending, show which checks agree but not their details (they contain values).
    checks: parseJson<Check[]>(c.checks_json, []).map((k) => (pending ? { ...k, detail: "Shown after you type the value" } : k)),
    last_decision: last && c.status !== "undecided" ? { action: last.action, by: last.actor, at: last.created_at, note: last.note } : null,
  };
}

async function referenceCard(env: Env, task: TaskRow, senderEmail: string | null): Promise<TaskView["reference"]> {
  const ref = await getReference(env, task.client_id);
  const facts = await getFacts(env, task.id);
  if (task.type === "tenant_email") {
    const t = findTenancy(ref, senderEmail, facts);
    if (!t) return null;
    return { title: `Tenancy register: ${t.tenant_name}`, rows: [["Property", t.property], ["Email", t.email], ["Rent", `${t.rent_weekly} per week, due ${t.rent_due_day}`], ["Bond", t.bond]] };
  }
  const s = findSupplier(facts.find((f) => f.label === "supplier_name")?.value ?? null, ref);
  if (!s) return { title: "Supplier list: no matching supplier", rows: [] };
  return { title: `Supplier list: ${s.name}`, rows: [["ABN", s.abn], ["BSB", s.bsb], ["Account", s.account], ["Usual code", s.default_account_code]] };
}

export async function buildTaskView(env: Env, task: TaskRow, actor: Actor): Promise<TaskView> {
  const client = (await getClient(env, task.client_id))!;
  const source = (await getSource(env, task.id))!;
  const draft = await getDraft(env, task.current_draft_id);
  const claims = draft ? await getClaims(env, draft.id) : [];
  const allClaims = await all<ClaimRow>(env.DB, "SELECT * FROM claims WHERE task_id = ?", task.id);
  const byId = new Map(allClaims.map((c) => [c.id, c]));
  const decisions = new Map<string, DecisionRow>();
  for (const d of await all<DecisionRow>(env.DB, "SELECT claim_id, action, actor, created_at, note FROM decisions WHERE task_id = ? ORDER BY created_at, rowid", task.id)) decisions.set(d.claim_id, d);
  const release = await first<{ id: string; created_at: string }>(env.DB, "SELECT id, created_at FROM releases WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", task.id);

  const display = draft ? (JSON.parse(draft.display_json ?? draft.content_json) as DraftContent) : null;
  const masked = display ? maskedContent(display, claims) : { content: null, spans: [] };
  const meta = parseJson<EmailMeta | null>(source.meta_json, null);
  const lockLive = task.lock_holder && task.lock_expires_at && task.lock_expires_at > nowIso(env);

  return {
    id: task.id,
    client_id: task.client_id,
    client_name: client.name,
    type: task.type,
    tier: task.tier,
    status: task.status as TaskView["status"],
    created_at: task.created_at,
    title: task.title,
    tier_reasons: taskTierReasons(task),
    lock: { holder: lockLive ? task.lock_holder : null, expires_at: lockLive ? task.lock_expires_at : null, mine: !!lockLive && task.lock_holder === actor.email },
    source:
      source.kind === "pdf"
        ? { kind: "pdf", filename: source.filename ?? "source.pdf", text: source.text, pages: parseJson<PdfPage[]>(source.layout_json, []), url: source.r2_key ? await signFileUrl(env, source.r2_key) : "" }
        : { kind: "email", text: source.text, quotedFrom: meta?.quoted_from ?? null },
    draft: draft && masked.content ? { id: draft.id, version: draft.version, content: masked.content } : { id: "", version: 0, content: { kind: "reply", reply: { to: [], subject: "", body: "" } } },
    masked_spans: masked.spans,
    claims: claims.map((c) => claimView(c, decisions, byId)),
    open_claims: claims.filter((c) => c.status === "undecided").length,
    flags: clientFlags(client),
    operator_approval: task.operator_approved_by ? { by: task.operator_approved_by, at: task.operator_approved_at! } : null,
    needs_licensed_reviewer: !!task.needs_licensed_reviewer,
    release: release ? { id: release.id, at: release.created_at } : null,
    reference: await referenceCard(env, task, meta?.from_email ?? null),
  };
}
