// Deterministic stand-in for the model stages. It lets the whole pipeline, UI and test suite run
// with no API key and no network. It is deliberately simple (regex and templates): it is not a
// measure of model quality. Re-run the fixture report with MODEL_MODE=anthropic for that.
import {
  DATE_PATTERNS,
  canonical,
  centsToDecimal,
  formatDate,
  locateQuote,
  matchName,
  parseDate,
  parseMoney,
  sweepNumbersAndDates,
  type BillEntry,
  type CheckOutput,
  type ExtractedFact,
  type ListedClaim,
  type LocatedFact,
  type ReplyDraft,
} from "@vc/shared";
import { PROMPTS } from "./prompts";
import type { CheckInput, DraftReplyInput, ModelResult, StageModel } from "./types";

const MODEL = "offline-stand-in";
const r = <T>(output: T, prompt: { version: string }): ModelResult<T> => ({ output, model: MODEL, promptVersion: `${prompt.version}+offline` });

const STOP = new Set(
  "a an and are as at be by can could do does for from have i if in is it its me my next of on or our please so that the this to us we what when where which who will with would you your hi hello thanks team there any about now".split(
    " ",
  ),
);

export function contentWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z][a-z']+/g) ?? []).map((w) => w.replace(/'s$/, "").replace(/s$/, "")).filter((w) => w.length > 2 && !STOP.has(w));
}

/** Body of an email without headers or quoted earlier messages. */
export function emailBody(text: string): { body: string; offset: number } {
  const blank = text.indexOf("\n\n");
  const offset = blank >= 0 ? blank + 2 : 0;
  let body = text.slice(offset);
  const q = body.search(/^(On .+wrote:|-{2,}\s*Original Message|>)/m);
  if (q >= 0) body = body.slice(0, q);
  return { body, offset };
}

function sentences(body: string, offset: number): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  const re = /[^.?!\n]+[.?!]?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const t = raw.trim();
    if (t.length > 1) out.push({ text: t, start: offset + m.index + lead });
  }
  return out;
}

const LEGAL = /\b(tribunal|NCAT|VCAT|QCAT|ombudsman|lawyer|solicitor|legal action|regulator|Residential Tenancies Act|termination notice|notice to vacate|breach notice)\b/i;
const AI_INSTRUCTIONS = /(ignore (all )?(previous|prior) instructions|note to the ai|ai assistant|system prompt)/i;

function extractBill(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const add = (kind: ExtractedFact["kind"], label: string, re: RegExp) => {
    const m = text.match(re);
    if (m) facts.push({ kind, label, value: m[1].trim(), quote: m[0].trim() });
  };
  const firstLine = text.split("\n")[0] ?? "";
  const supplier = firstLine.replace(/\s*TAX INVOICE\s*$/i, "").trim();
  if (supplier) facts.push({ kind: "party", label: "supplier_name", value: supplier, quote: supplier });
  add("abn", "supplier_abn", /ABN:?\s*(\d{2} ?\d{3} ?\d{3} ?\d{3})/);
  add("address", "property", /Property:\s*(.+)/);
  add("reference", "invoice_number", /Invoice No:?\s*(\S+)/);
  add("date", "invoice_date", /Invoice Date:\s*(.+)/);
  add("date", "due_date", /Due Date:\s*(.+)/);
  add("amount", "subtotal", /^Subtotal\s+(\$[\d,]+\.\d{2})/m);
  add("amount", "gst_amount", /^GST\s+(\$[\d,]+\.\d{2})/m);
  add("amount", "total_amount", /^Total(?: due)?\s+(\$[\d,]+\.\d{2})/m);
  add("bank", "bank_bsb", /BSB\s+(\d{3}-\d{3})/);
  add("bank", "bank_account", /Account\s+(\d{4} \d{4})/);
  const itemsBlock = text.match(/Description\s+Amount\n([\s\S]*?)\nSubtotal/);
  if (itemsBlock) {
    for (const line of itemsBlock[1].split("\n")) {
      const m = line.match(/^(.*\S)\s+(\$[\d,]+\.\d{2})$/);
      if (m) facts.push({ kind: "line_item", label: m[1], value: m[2], quote: line.trim() });
    }
  }
  return facts;
}

function extractEmail(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const from = text.match(/^From:\s*(?:"?([^"<\n]+?)"?\s*)?<([^>\n]+)>/m);
  if (from) {
    if (from[1]) facts.push({ kind: "party", label: "sender_name", value: from[1].trim(), quote: from[1].trim() });
    facts.push({ kind: "party", label: "sender_email", value: from[2].trim(), quote: from[2].trim() });
  }
  const { body, offset } = emailBody(text);
  for (const s of sentences(body, offset)) {
    if (s.text.endsWith("?")) facts.push({ kind: "question", label: "question", value: s.text.replace(/^\d+\.\s*/, ""), quote: s.text.replace(/^\d+\.\s*/, "") });
    else if (/^(please|could you|can you)\b/i.test(s.text)) facts.push({ kind: "request", label: "request", value: s.text, quote: s.text });
    if (AI_INSTRUCTIONS.test(s.text)) facts.push({ kind: "statement", label: "ai_instructions", value: s.text, quote: s.text });
    else if (LEGAL.test(s.text)) facts.push({ kind: "statement", label: "legal", value: s.text, quote: s.text });
    else if (!s.text.endsWith("?") && s.text.split(/\s+/).length >= 4) facts.push({ kind: "statement", label: "statement", value: s.text, quote: s.text });
  }
  for (const t of sweepNumbersAndDates(body)) {
    if (t.kind === "money") {
      const sentence = sentences(body, 0).find((s) => t.start >= s.start && t.end <= s.start + s.text.length);
      const label = sentence && /rent/i.test(sentence.text) ? "rent" : "amount";
      facts.push({ kind: "amount", label, value: t.text, quote: t.text });
    } else if (t.kind === "date") {
      facts.push({ kind: "date", label: "date", value: t.text, quote: t.text });
    }
  }
  const addr = body.match(/\b(?:Unit \d+\/|\d+\/)?\d+[A-Za-z]? [A-Z][a-z]+(?: [A-Z][a-z]+)? (?:Street|St|Road|Rd|Lane|Close|Parade|Crescent|Avenue|Ave|Drive)\b/);
  if (addr) facts.push({ kind: "address", label: "property", value: addr[0], quote: addr[0] });
  return facts;
}

function draftBill(facts: LocatedFact[], suppliers: { name: string; default_account_code: string }[]): BillEntry {
  const v = (label: string) => facts.find((f) => f.label === label)?.value ?? null;
  const date = (label: string) => {
    const raw = v(label);
    return raw ? (parseDate(raw)?.iso ?? null) : null;
  };
  const money = (label: string) => {
    const c = parseMoney(v(label));
    return c == null ? null : centsToDecimal(c);
  };
  const name = v("supplier_name");
  const match = name ? matchName(name, suppliers.map((s) => s.name)) : { kind: "none" as const };
  const supplier = match.kind !== "none" ? suppliers.find((s) => s.name === match.name) : undefined;
  const items = facts.filter((f) => f.kind === "line_item").map((f) => f.label);
  return {
    supplier_name: name,
    supplier_abn: v("supplier_abn"),
    invoice_number: v("invoice_number"),
    invoice_date: date("invoice_date"),
    due_date: date("due_date"),
    total_amount: money("total_amount"),
    gst_amount: money("gst_amount"),
    account_code: supplier?.default_account_code ?? "6110",
    property: v("property"),
    bank_bsb: v("bank_bsb"),
    bank_account: v("bank_account"),
    description: items.length ? items.join("; ") : null,
  };
}

function draftReply(i: DraftReplyInput): ReplyDraft {
  const first = (i.senderName ?? "").split(/\s+/)[0] || "there";
  const paras: string[] = [];
  const used = new Set<string>();
  const questions = i.facts.filter((f) => f.kind === "question" || f.kind === "request");
  for (const q of questions) {
    const lower = q.value.toLowerCase();
    const faq = i.playbook.faq.find(
      (f) => !used.has(f.topic) && f.keywords.some((k) => lower.includes(k)) && (!f.also || f.also.some((k) => lower.includes(k))),
    );
    if (!faq) continue;
    used.add(faq.topic);
    const requested = i.facts.find((f) => f.kind === "date");
    const iso = requested ? parseDate(requested.value)?.iso : null;
    paras.push(
      faq.answer
        .replace("{rent_weekly}", i.tenancy?.rent_weekly ?? "your agreed rent")
        .replace("{rent_due_day}", i.tenancy?.rent_due_day ?? "week")
        .replace("{requested_date}", iso ? formatDate(iso) : "the date you asked for"),
    );
  }
  // Topics raised without a question mark (complaints, bond, repairs).
  const all = i.facts.map((f) => f.value.toLowerCase()).join(" ");
  for (const topic of ["repairs", "bond", "rent_amount"]) {
    const faq = i.playbook.faq.find((f) => f.topic === topic);
    if (faq && !used.has(topic) && faq.keywords.some((k) => all.includes(k)) && used.size === 0) {
      used.add(topic);
      paras.push(faq.answer.replace("{rent_weekly}", i.tenancy?.rent_weekly ?? "").replace("{rent_due_day}", i.tenancy?.rent_due_day ?? ""));
    }
  }
  if (i.facts.some((f) => f.label === "legal")) {
    paras.push("We've passed your email to our senior property manager, who will contact you directly.");
  }
  if (paras.length === 0) paras.push("Thanks for letting us know. We've noted this on your file.");
  const body = [`Hi ${first},`, "Thanks for your email.", ...paras, `Kind regards,\n${i.playbook.sign_off}`].join("\n\n");
  return { subject: "Re: your email", body };
}

const COMMITMENT = /\b(we'll|we will|will be|will (contact|call|follow|arrange|send|confirm|check|ask|let)|within \d+|by (mon|tue|wed|thu|fri|sat|sun))/i;
const POLICY = /\b(need|needs|must|policy|required|are lodged|is lodged)\b/i;

function listClaims(body: string, ownNames: string[]): ListedClaim[] {
  const claims: ListedClaim[] = [];
  const counts = new Map<string, number>();
  const push = (type: ListedClaim["type"], text: string, at: number) => {
    // occurrence = how many times this exact text appears up to and including `at`
    let n = 0;
    let i = body.indexOf(text);
    while (i >= 0 && i <= at) {
      n++;
      i = body.indexOf(text, i + 1);
    }
    const key = `${type}|${text}|${n}`;
    if (!counts.has(key)) {
      counts.set(key, 1);
      claims.push({ type, text, occurrence: Math.max(1, n) });
    }
  };
  const signOff = body.lastIndexOf("Kind regards");
  const main = signOff >= 0 ? body.slice(0, signOff) : body;
  for (const t of sweepNumbersAndDates(main)) push(t.kind === "money" ? "amount" : t.kind === "date" ? "date" : "number", t.text, t.start);
  const greet = main.match(/^(?:Hi|Hello|Dear) ([A-Z][a-z]+)/m);
  if (greet && !ownNames.some((n) => n.toLowerCase() === greet[1].toLowerCase())) push("name", greet[1], (greet.index ?? 0) + greet[0].indexOf(greet[1]));
  for (const m of main.matchAll(/[\w.+-]+@[\w-]+\.[\w.]+/g)) push("email", m[0], m.index ?? 0);
  for (const s of sentences(main, 0)) {
    if (/^(hi|hello|dear)\b/i.test(s.text) || /^thanks for your email/i.test(s.text)) continue;
    if (LEGAL.test(s.text)) push("legal", s.text, s.start);
    else if (COMMITMENT.test(s.text)) push("commitment", s.text, s.start);
    else if (POLICY.test(s.text)) push("policy", s.text, s.start);
  }
  return claims;
}

function check(i: CheckInput): CheckOutput {
  const src = i.sourceText;
  const verdicts: CheckOutput["verdicts"] = [];
  const facts = extractedFor(i);
  for (const c of i.claims) {
    if (i.taskType === "supplier_bill") {
      verdicts.push(checkBillClaim(c, facts, src));
      continue;
    }
    if (["amount", "date", "number", "reference", "email", "phone"].includes(c.type)) {
      const t = c.type as "amount" | "date" | "number";
      const same = facts.find((f) => (f.kind === "amount" || f.kind === "date") && canonical(t, f.value) === canonical(t, c.text));
      const literal = locateQuote(src, c.text);
      if (same) {
        verdicts.push({ claim_id: c.id, verdict: "supported", source_quote: same.quote, source_value: same.value, note: "Stated in the source." });
      } else if (literal) {
        verdicts.push({ claim_id: c.id, verdict: "supported", source_quote: c.text, source_value: c.text, note: "Appears in the source." });
      } else {
        const sameKind = facts.find((f) => f.kind === (c.type === "date" ? "date" : "amount") && sharesTopic(f, i.draftBody, c.text));
        verdicts.push(
          sameKind
            ? { claim_id: c.id, verdict: "contradicted", source_quote: sameKind.quote, source_value: sameKind.value, note: `Source says ${sameKind.value}.` }
            : { claim_id: c.id, verdict: "not_found", source_quote: null, source_value: null, note: "Not stated in the source." },
        );
      }
      continue;
    }
    if (c.type === "name") {
      const span = locateQuote(src.toLowerCase(), c.text.toLowerCase());
      verdicts.push(
        span
          ? { claim_id: c.id, verdict: "supported", source_quote: src.slice(span.start, span.end), source_value: src.slice(span.start, span.end), note: "Name appears in the source." }
          : { claim_id: c.id, verdict: "not_found", source_quote: null, source_value: null, note: "Name not in the source." },
      );
      continue;
    }
    const literal = locateQuote(src, c.text);
    verdicts.push(
      literal
        ? { claim_id: c.id, verdict: "supported", source_quote: c.text, source_value: c.text, note: "Stated in the source." }
        : { claim_id: c.id, verdict: "not_found", source_quote: null, source_value: null, note: "The source doesn't say this." },
    );
  }
  const draftWords = new Set(contentWords(i.draftBody));
  const unanswered = i.questions
    .filter((q) => !contentWords(q.value).some((w) => draftWords.has(w)))
    .map((q) => ({ quote: q.quote, summary: `Not addressed: ${q.value}` }));
  return { verdicts, unanswered };
}

function extractedFor(i: CheckInput): ExtractedFact[] {
  return i.taskType === "supplier_bill" ? extractBill(i.sourceText) : extractEmail(i.sourceText);
}

function sharesTopic(f: ExtractedFact, draftBody: string, claimText: string): boolean {
  const at = draftBody.indexOf(claimText);
  const sentence = at >= 0 ? draftBody.slice(Math.max(0, draftBody.lastIndexOf(".", at) + 1), draftBody.indexOf(".", at + claimText.length) + 1) : "";
  return f.label !== "amount" && f.label !== "date" ? sentence.toLowerCase().includes(f.label) : false;
}

const FIELD_TYPES: Record<string, "name" | "abn" | "reference" | "date" | "amount" | "bank" | "address"> = {
  supplier_name: "name",
  supplier_abn: "abn",
  invoice_number: "reference",
  invoice_date: "date",
  due_date: "date",
  total_amount: "amount",
  gst_amount: "amount",
  bank_bsb: "bank",
  bank_account: "bank",
  property: "address",
};

function checkBillClaim(c: { id: string; label: string; text: string }, facts: ExtractedFact[], src: string): CheckOutput["verdicts"][number] {
  const field = c.label;
  if (field === "description") {
    const parts = c.text.split(";").map((p) => p.trim());
    const all = parts.every((p) => locateQuote(src, p));
    return all
      ? { claim_id: c.id, verdict: "supported", source_quote: parts[0], source_value: c.text, note: "Line items appear in the source." }
      : { claim_id: c.id, verdict: "not_found", source_quote: null, source_value: null, note: "Some line items are not in the source." };
  }
  if (field === "account_code") return { claim_id: c.id, verdict: "not_found", source_quote: null, source_value: null, note: "Account codes come from our chart of accounts, not the invoice." };
  const fact = facts.find((f) => f.label === field);
  const type = FIELD_TYPES[field];
  if (!fact || !type) return { claim_id: c.id, verdict: "not_found", source_quote: null, source_value: null, note: "Not on the invoice." };
  const same = canonical(type, fact.value) === canonical(type, c.text);
  return {
    claim_id: c.id,
    verdict: same ? "supported" : "contradicted",
    source_quote: fact.quote,
    source_value: fact.value,
    note: same ? "Matches the invoice." : `Invoice says ${fact.value}.`,
  };
}

export function offlineModel(): StageModel {
  return {
    mode: "offline",
    async classify({ sourceText }) {
      const reasons: string[] = [];
      if (AI_INSTRUCTIONS.test(sourceText)) reasons.push("Source contains text aimed at an AI assistant");
      return r({ tier: reasons.length ? 3 : 1, reasons }, PROMPTS.classify);
    },
    async extract({ taskType, sourceText }) {
      return r({ facts: taskType === "supplier_bill" ? extractBill(sourceText) : extractEmail(sourceText) }, PROMPTS.extract);
    },
    async draftBill({ facts, reference }) {
      return r(draftBill(facts, reference.suppliers), PROMPTS.draft_bill);
    },
    async draftReply(i) {
      return r(draftReply(i), PROMPTS.draft_reply);
    },
    async listClaims({ body, ownNames }) {
      return r({ claims: listClaims(body, ownNames) }, PROMPTS.list_claims);
    },
    async check(i) {
      return r(check(i), PROMPTS.check);
    },
  };
}

// Exported for tests.
export const _internal = { extractBill, extractEmail, listClaims, DATE_PATTERNS };
