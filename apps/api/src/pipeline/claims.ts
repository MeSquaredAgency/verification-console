// Building the claims list for a draft, running the independent and coded checks on it,
// and deciding which Panel 3 group each claim belongs to.
import {
  BILL_FIELDS,
  canonical,
  locateQuote,
  occurrences,
  sweepNumbersAndDates,
  type BillEntry,
  type Check,
  type ClaimGroup,
  type ClaimType,
  type DraftContent,
  type LocatedFact,
  type Playbook,
  type ReferenceData,
  type TaskType,
  type Tenancy,
} from "@vc/shared";
import { logged } from "../model";
import type { StageModel } from "../model/types";
import type { Env } from "../lib/env";
import { billCodedChecks, recipientChecks, replyCodedChecks } from "./rules";

export const BILL_LABELS: Record<string, string> = {
  supplier_name: "Supplier",
  supplier_abn: "ABN",
  invoice_number: "Invoice no.",
  invoice_date: "Invoice date",
  due_date: "Due date",
  total_amount: "Amount",
  gst_amount: "GST",
  account_code: "Account code",
  property: "Property",
  bank_bsb: "BSB",
  bank_account: "Bank account",
  description: "Description",
};

export const BILL_FIELD_TYPES: Record<string, ClaimType> = {
  supplier_name: "name",
  supplier_abn: "abn",
  invoice_number: "reference",
  invoice_date: "date",
  due_date: "date",
  total_amount: "amount",
  gst_amount: "amount",
  account_code: "account_code",
  property: "address",
  bank_bsb: "bank",
  bank_account: "bank",
  description: "text",
};

const TYPE_LABELS: Partial<Record<ClaimType, string>> = {
  name: "Name",
  date: "Date",
  amount: "Amount",
  number: "Number",
  reference: "Reference",
  address: "Address",
  email: "Email address",
  phone: "Phone",
  commitment: "Commitment",
  policy: "Policy statement",
  legal: "Legal statement",
  question: "Unanswered",
  text: "Text",
};

/** A claim before it is stored. Positions are in the true draft. */
export type BuiltClaim = {
  key: string; // identity across draft versions: type|field|canonical value|occurrence
  type: ClaimType;
  label: string;
  field: string | null;
  value: string;
  true_start: number | null;
  true_end: number | null;
  source_value: string | null;
  source_span: { start: number; end: number } | null;
  checks: Check[];
  model_verdict: string | null;
  group: ClaimGroup;
  needs_rekey: boolean;
};

export type ClaimContext = {
  env: Env;
  model: StageModel;
  taskId: string;
  taskType: TaskType;
  sourceText: string;
  facts: LocatedFact[];
  ref: ReferenceData;
  playbook: Playbook;
  tenancy: Tenancy | null;
  senderEmail: string | null;
  today: string;
  refYear: number;
};

export type Candidate = Omit<BuiltClaim, "source_value" | "source_span" | "checks" | "model_verdict" | "group" | "needs_rekey" | "key">;

/** Step 4: list the draft's claims. Model listing plus a coded sweep so nothing numeric escapes. */
export async function listCandidates(ctx: ClaimContext, content: DraftContent): Promise<Candidate[]> {
  if (content.kind === "bill") {
    return BILL_FIELDS.filter((f) => content.bill[f] != null && content.bill[f] !== "").map((f) => ({
      type: BILL_FIELD_TYPES[f],
      label: BILL_LABELS[f],
      field: f,
      value: String(content.bill[f]),
      true_start: null,
      true_end: null,
    }));
  }
  const body = content.reply.body;
  const out: Candidate[] = [
    { type: "email", label: "Recipient", field: "to", value: content.reply.to.join(", "), true_start: null, true_end: null },
    { type: "text", label: "Subject", field: "subject", value: content.reply.subject, true_start: null, true_end: null },
  ];
  const listed = await logged(ctx.env, ctx.taskId, "list_claims", ctx.model.mode, { body }, () => ctx.model.listClaims({ body, ownNames: ctx.playbook.own_names }));
  const seen = new Set<string>();
  for (const c of listed.output.claims) {
    const occ = occurrences(body, c.text);
    const at = occ[Math.max(0, Math.min(occ.length - 1, c.occurrence - 1))];
    if (at == null) continue; // the model quoted something that isn't in the draft
    const k = `${at}:${c.text.length}:${c.type}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ type: c.type, label: TYPE_LABELS[c.type] ?? c.type, field: null, value: c.text, true_start: at, true_end: at + c.text.length });
  }
  // Coded sweep: every number and date in the body must be covered by a claim of its own.
  const numeric = new Set<ClaimType>(["amount", "date", "number", "reference", "phone", "abn", "bank"]);
  for (const t of sweepNumbersAndDates(body)) {
    const covered = out.some((c) => c.true_start != null && numeric.has(c.type) && c.true_start <= t.start && c.true_end! >= t.end);
    if (covered) continue;
    const type: ClaimType = t.kind === "money" ? "amount" : t.kind === "date" ? "date" : "number";
    out.push({ type, label: TYPE_LABELS[type]!, field: null, value: t.text, true_start: t.start, true_end: t.end });
  }
  return out.sort((a, b) => (a.true_start ?? -1) - (b.true_start ?? -1));
}

export function claimKey(c: { type: string; field: string | null; value: string }, occurrence: number): string {
  return `${c.type}|${c.field ?? ""}|${canonical(c.type as ClaimType, c.value)}|${occurrence}`;
}

function withKeys<T extends { type: string; field: string | null; value: string }>(cands: T[]): (T & { key: string })[] {
  const counts = new Map<string, number>();
  return cands.map((c) => {
    const base = claimKey(c, 0);
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    return { ...c, key: claimKey(c, n) };
  });
}

export function groupFor(c: { type: ClaimType; checks: Check[]; model_verdict: string | null }, needsRekey: boolean): ClaimGroup {
  if (c.type === "question") return "omitted";
  if (needsRekey) return "rekey";
  if (c.checks.some((k) => k.result === "disagree")) return "mismatch";
  if (c.model_verdict === "not_found") {
    if (["commitment", "policy", "legal", "text"].includes(c.type)) return "unsupported";
    const backed = c.checks.some((k) => k.result === "agree" && k.check !== "independent_check");
    return backed ? "matched" : "mismatch";
  }
  return "matched";
}

export function needsRekey(type: ClaimType, tier: number): boolean {
  return tier >= 2 && (type === "amount" || type === "date");
}

function codedFor(ctx: ClaimContext, content: DraftContent, c: Candidate, commitmentSpans: { start: number; end: number }[]): Check[] {
  if (content.kind === "bill") {
    return billCodedChecks(c.field!, c.value, { facts: ctx.facts, ref: ctx.ref, bill: content.bill as BillEntry, today: ctx.today, refYear: ctx.refYear });
  }
  if (c.field === "to") return recipientChecks(content.reply.to, ctx.senderEmail, ctx.ref);
  if (c.field === "subject") return [{ check: "subject_from_source", result: "agree", detail: "Set by code from the email being answered" }];
  return replyCodedChecks(c.type, c.value, c.true_start != null ? { start: c.true_start, end: c.true_end! } : null, {
    facts: ctx.facts,
    ref: ctx.ref,
    ownNames: ctx.playbook.own_names,
    tenancy: ctx.tenancy,
    senderEmail: ctx.senderEmail,
    today: ctx.today,
    refYear: ctx.refYear,
    body: content.reply.body,
    commitmentSpans,
  });
}

/**
 * Steps 5 and 6: independent check (a separate call that sees the source and the claims, not the
 * drafting prompt) and coded checks. `recheckKeys` limits the model call to changed claims; the
 * rest reuse `previous` results.
 */
export type PreviousChecks = Map<string, Pick<BuiltClaim, "checks" | "model_verdict" | "source_value" | "source_span">>;

export async function checkCandidates(ctx: ClaimContext, content: DraftContent, listed: Candidate[], tier: number, opts: { previous?: PreviousChecks } = {}): Promise<BuiltClaim[]> {
  const cands = withKeys(listed);
  const body = content.kind === "reply" ? content.reply.body : "";
  const commitmentSpans = cands.filter((c) => c.type === "commitment" && c.true_start != null).map((c) => ({ start: c.true_start!, end: c.true_end! }));

  const toCheck = cands.filter((c) => c.field !== "to" && c.field !== "subject" && !opts.previous?.has(c.key));
  const verdicts = new Map<string, { verdict: string; quote: string | null; value: string | null; note: string }>();
  let unanswered: { quote: string; summary: string }[] = [];
  if (toCheck.length > 0 || !opts.previous || content.kind === "reply") {
    const claimsIn = toCheck.map((c, i) => ({ id: `c${i}`, type: c.type, label: c.field ?? c.label, text: c.value }));
    const questions = ctx.facts.filter((f) => f.kind === "question" || f.kind === "request");
    const res = await logged(ctx.env, ctx.taskId, "check", ctx.model.mode, { claimsIn, body }, () =>
      ctx.model.check({ taskType: ctx.taskType, sourceText: ctx.sourceText, draftBody: body, claims: claimsIn, questions }),
    );
    for (const v of res.output.verdicts) {
      const idx = Number(v.claim_id.slice(1));
      const c = toCheck[idx];
      if (c) verdicts.set(c.key, { verdict: v.verdict, quote: v.source_quote, value: v.source_value, note: v.note });
    }
    unanswered = content.kind === "reply" ? res.output.unanswered : [];
  }

  const out: BuiltClaim[] = [];
  for (const c of cands) {
    const prev = opts.previous?.get(c.key);
    let model_verdict: string | null = prev?.model_verdict ?? null;
    let source_value = prev?.source_value ?? null;
    let source_span = prev?.source_span ?? null;
    let independent: Check | null = prev?.checks.find((k) => k.check === "independent_check") ?? null;
    const v = verdicts.get(c.key);
    if (v) {
      const span = v.quote ? locateQuote(ctx.sourceText, v.quote) : null;
      model_verdict = v.verdict === "supported" && !span ? "not_found" : v.verdict;
      source_value = v.value;
      source_span = span;
      const note = v.verdict === "supported" && !span ? "Checker's quote was not found in the source" : v.note;
      independent = { check: "independent_check", result: model_verdict === "supported" ? "agree" : model_verdict === "contradicted" ? "disagree" : "not_found", detail: note };
    }
    if (content.kind === "bill" && c.field) {
      const fact = c.field === "description" ? null : ctx.facts.find((f) => f.label === c.field);
      if (fact) {
        source_span = source_span ?? fact.span;
        source_value = source_value ?? fact.value;
      }
      if (c.field === "description") {
        const items = ctx.facts.filter((f) => f.kind === "line_item");
        if (items.length) source_span = { start: Math.min(...items.map((i) => i.span.start)), end: Math.max(...items.map((i) => i.span.end)) };
      }
    }
    const checks = [...(independent ? [independent] : []), ...codedFor(ctx, content, c, commitmentSpans)];
    const rekey = needsRekey(c.type, tier);
    out.push({ ...c, source_value, source_span, checks, model_verdict, needs_rekey: rekey, group: groupFor({ type: c.type, checks, model_verdict }, rekey) });
  }

  for (const [i, u] of unanswered.entries()) {
    const span = locateQuote(ctx.sourceText, u.quote);
    const checks: Check[] = [{ check: "independent_check", result: "disagree", detail: u.summary }];
    out.push({
      key: `question||${canonical("text", u.quote)}|${i + 1}`,
      type: "question",
      label: "Unanswered",
      field: null,
      value: u.quote,
      true_start: null,
      true_end: null,
      source_value: u.quote,
      source_span: span,
      checks,
      model_verdict: "not_found",
      needs_rekey: false,
      group: "omitted",
    });
  }
  return out;
}

export function regroup(c: BuiltClaim, tier: number): BuiltClaim {
  const rekey = needsRekey(c.type, tier);
  return { ...c, needs_rekey: rekey, group: groupFor(c, rekey) };
}
