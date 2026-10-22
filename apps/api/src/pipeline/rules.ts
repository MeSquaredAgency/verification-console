// Coded rules: tiering and the checks that are plain code, not model judgement.
// Rules set the tier first; the model may only raise it, never lower it.
import {
  addDays,
  canonical,
  digitsOnly,
  formatCents,
  formatDate,
  gstOf,
  isValidAbn,
  matchName,
  normaliseAbn,
  parseDate,
  parseMoney,
  sweepNumbersAndDates,
  weekdayOf,
  WEEKDAY_NAMES,
  type BillEntry,
  type Check,
  type ClaimType,
  type LocatedFact,
  type ReferenceData,
  type Supplier,
  type Tenancy,
  type TaskType,
} from "@vc/shared";
import { emailBody } from "../model/offline";

export type TierResult = { tier: number; reasons: string[]; licensed: boolean };

const KEYWORDS: { code: string; tier: number; re: RegExp; text: string; licensed?: boolean }[] = [
  { code: "rta_notice", tier: 3, re: /\b(Residential Tenancies Act|notice to vacate|termination notice|breach notice)\b/i, text: "Notice under the Residential Tenancies Act", licensed: true },
  { code: "tribunal_or_legal", tier: 3, re: /\b(tribunal|NCAT|VCAT|QCAT|ombudsman|lawyer|solicitor|legal action|regulator)\b/i, text: "Mentions a tribunal, ombudsman, lawyer or regulator" },
  { code: "bond", tier: 3, re: /\bbond\b/i, text: "Bond matter" },
  { code: "ai_instructions_in_source", tier: 3, re: /(ignore (all )?(previous|prior) instructions|note to the ai|ai assistant|system prompt)/i, text: "Source contains instructions aimed at the AI" },
];

export function mergeTier(a: TierResult, b: Partial<TierResult>): TierResult {
  const reasons = [...a.reasons];
  for (const r of b.reasons ?? []) if (!reasons.includes(r)) reasons.push(r);
  return { tier: Math.max(a.tier, b.tier ?? 1), reasons, licensed: a.licensed || !!b.licensed };
}

/** Rules on the source alone (run before any model call). */
export function sourceTierRules(type: TaskType, text: string, senderEmail: string | null, ref: ReferenceData): TierResult {
  let res: TierResult = type === "supplier_bill" ? { tier: 2, reasons: ["supplier_bill: Supplier bill"], licensed: false } : { tier: 1, reasons: [], licensed: false };
  const body = type === "tenant_email" ? emailBody(text).body : text;
  for (const k of KEYWORDS) {
    if (type === "supplier_bill" && k.code !== "ai_instructions_in_source") continue;
    if (k.re.test(body)) res = mergeTier(res, { tier: k.tier, reasons: [`${k.code}: ${k.text}`], licensed: k.licensed });
  }
  if (type === "tenant_email") {
    const toks = sweepNumbersAndDates(body).filter((t) => t.kind !== "number");
    if (toks.length) res = mergeTier(res, { tier: 2, reasons: ["money_or_date_in_source: Source quotes an amount or date"] });
    const known = senderEmail && (ref.tenancies.some((t) => t.email.toLowerCase() === senderEmail) || ref.contacts.some((c) => c.email.toLowerCase() === senderEmail));
    if (!known) res = mergeTier(res, { tier: 2, reasons: [`unknown_sender: ${senderEmail ?? "Sender"} is not a known tenant or contact`] });
  }
  return res;
}

/** Rules once facts are extracted: threshold and bank details. */
export function factTierRules(type: TaskType, facts: LocatedFact[], ref: ReferenceData, thresholdCents: number): TierResult {
  let res: TierResult = { tier: 1, reasons: [], licensed: false };
  if (type !== "supplier_bill") return res;
  const total = parseMoney(facts.find((f) => f.label === "total_amount")?.value);
  if (total != null && total > thresholdCents) {
    res = mergeTier(res, { tier: 3, reasons: [`over_threshold: Total ${formatCents(total)} is over the ${formatCents(thresholdCents)} threshold`] });
  }
  const bsb = facts.find((f) => f.label === "bank_bsb")?.value;
  const acct = facts.find((f) => f.label === "bank_account")?.value;
  if (bsb || acct) {
    const supplier = findSupplier(facts.find((f) => f.label === "supplier_name")?.value ?? null, ref);
    const differs = !supplier || digitsOnly(supplier.bsb) !== digitsOnly(bsb) || digitsOnly(supplier.account) !== digitsOnly(acct);
    if (differs) res = mergeTier(res, { tier: 3, reasons: ["bank_details_changed: Supplier bank details differ from our record"] });
  }
  return res;
}

/** Rules on the draft: any amount, date or promise makes a reply at least tier 2. */
export function draftTierRules(claimTypes: ClaimType[]): TierResult {
  if (claimTypes.some((t) => t === "amount" || t === "date" || t === "commitment")) {
    return { tier: 2, reasons: ["draft_money_date_or_promise: Draft quotes an amount, date or promise"], licensed: false };
  }
  return { tier: 1, reasons: [], licensed: false };
}

export function findSupplier(name: string | null, ref: ReferenceData): Supplier | undefined {
  if (!name) return undefined;
  const m = matchName(name, ref.suppliers.map((s) => s.name));
  return m.kind === "none" ? undefined : ref.suppliers.find((s) => s.name === m.name);
}

export function findTenancy(ref: ReferenceData, senderEmail: string | null, facts: LocatedFact[]): Tenancy | null {
  if (senderEmail) {
    const t = ref.tenancies.find((x) => x.email.toLowerCase() === senderEmail);
    if (t) return t;
  }
  const addr = facts.find((f) => f.label === "property")?.value?.toLowerCase();
  if (addr) {
    const t = ref.tenancies.find((x) => x.property.toLowerCase().startsWith(addr) || x.property.toLowerCase().includes(addr));
    if (t) return t;
  }
  return null;
}

// ---------- Coded checks ----------

const agree = (check: string, detail: string): Check => ({ check, result: "agree", detail });
const disagree = (check: string, detail: string): Check => ({ check, result: "disagree", detail });
const info = (check: string, detail: string): Check => ({ check, result: "info", detail });

export type BillCheckContext = { facts: LocatedFact[]; ref: ReferenceData; bill: BillEntry; today: string; refYear: number };

function dateChecks(field: string, iso: string | null, sourceRaw: string | undefined, refYear: number): Check[] {
  const out: Check[] = [];
  if (!iso || !parseDate(iso)) return [disagree("date_valid", `${iso ?? "(empty)"} is not a valid date`)];
  out.push(agree("date_valid", `${formatDate(iso)} is a valid date`));
  if (sourceRaw) {
    const p = parseDate(sourceRaw, refYear);
    if (p?.ambiguous) {
      const [y, m, d] = p.iso.split("-").map(Number);
      const swapped = `${y}-${String(d).padStart(2, "0")}-${String(m).padStart(2, "0")}`;
      out.push(disagree("date_unambiguous", `Source writes ${sourceRaw}: could be ${formatDate(p.iso)} or ${formatDate(swapped)}`));
    }
    if (p && p.statedWeekday != null && p.statedWeekday !== weekdayOf(p.iso)) {
      out.push(disagree("weekday_matches", `Source says ${WEEKDAY_NAMES[p.statedWeekday]}, but ${formatDate(p.iso).slice(4)} is a ${WEEKDAY_NAMES[weekdayOf(p.iso)]}`));
    } else if (p?.statedWeekday != null) {
      out.push(agree("weekday_matches", "Weekday matches the date"));
    }
  }
  void field;
  return out;
}

export function billCodedChecks(field: string, value: string | null, ctx: BillCheckContext): Check[] {
  const { facts, ref, bill } = ctx;
  const fact = (label: string) => facts.find((f) => f.label === label);
  const out: Check[] = [];
  switch (field) {
    case "total_amount": {
      const total = parseMoney(value);
      if (total == null) return [disagree("amount_parses", `"${value}" is not an amount`)];
      out.push(agree("amount_parses", formatCents(total)));
      const src = parseMoney(fact("total_amount")?.value);
      if (src != null) out.push(src === total ? agree("equals_source", "Equals the invoice total") : disagree("equals_source", `Invoice total is ${formatCents(src)}`));
      const items = facts.filter((f) => f.kind === "line_item").map((f) => parseMoney(f.value) ?? 0);
      const sub = parseMoney(fact("subtotal")?.value);
      const gst = parseMoney(fact("gst_amount")?.value) ?? 0;
      if (items.length) {
        const sum = items.reduce((a, b) => a + b, 0);
        const target = sub ?? total - gst;
        out.push(sum === target ? agree("line_items_sum", `Line items sum to ${formatCents(sum)}`) : disagree("line_items_sum", `Line items sum to ${formatCents(sum)}, but the invoice says ${formatCents(target)}`));
      }
      if (sub != null && sub + gst !== total) out.push(disagree("totals_reconcile", `Subtotal ${formatCents(sub)} + GST ${formatCents(gst)} = ${formatCents(sub + gst)}, not ${formatCents(total)}`));
      break;
    }
    case "gst_amount": {
      const gst = parseMoney(value);
      const total = parseMoney(bill.total_amount);
      if (gst == null) return [disagree("amount_parses", `"${value}" is not an amount`)];
      const src = parseMoney(fact("gst_amount")?.value);
      if (src != null) out.push(src === gst ? agree("equals_source", "Equals the invoice GST") : disagree("equals_source", `Invoice GST is ${formatCents(src)}`));
      if (total != null) {
        const expected = gstOf(total);
        out.push(Math.abs(expected - gst) <= 1 ? agree("gst_one_eleventh", `${formatCents(gst)} is 1/11 of ${formatCents(total)}`) : disagree("gst_one_eleventh", `1/11 of ${formatCents(total)} is ${formatCents(expected)}, not ${formatCents(gst)}`));
      }
      break;
    }
    case "supplier_abn": {
      if (!value) return out;
      out.push(isValidAbn(value) ? agree("abn_checksum", "ABN passes its checksum") : disagree("abn_checksum", `ABN ${value} fails the checksum`));
      const supplier = findSupplier(bill.supplier_name, ref);
      if (supplier) out.push(normaliseAbn(supplier.abn) === normaliseAbn(value) ? agree("abn_matches_record", `Matches ${supplier.name}`) : disagree("abn_matches_record", `Our record for ${supplier.name} is ${supplier.abn}`));
      else out.push(disagree("abn_matches_record", "No supplier record to compare"));
      break;
    }
    case "supplier_name": {
      if (!value) return out;
      const m = matchName(value, ref.suppliers.map((s) => s.name));
      if (m.kind === "exact") out.push(agree("supplier_list", `In supplier list: ${m.name}`));
      else if (m.kind === "near") out.push(disagree("supplier_list", `Near-match only: our supplier list has "${m.name}"`));
      else out.push(disagree("supplier_list", "Not in the supplier list"));
      break;
    }
    case "bank_bsb":
    case "bank_account": {
      const supplier = findSupplier(bill.supplier_name, ref);
      const ours = supplier ? (field === "bank_bsb" ? supplier.bsb : supplier.account) : null;
      if (!ours) out.push(disagree("bank_details_match", "No bank record for this supplier: forces tier 3"));
      else out.push(digitsOnly(ours) === digitsOnly(value) ? agree("bank_details_match", `Matches our record for ${supplier!.name}`) : disagree("bank_details_match", `Our record is ${ours}: differs, forces tier 3`));
      break;
    }
    case "invoice_date":
    case "due_date": {
      out.push(...dateChecks(field, value, fact(field)?.value, ctx.refYear));
      if (field === "due_date" && value && bill.invoice_date && value < bill.invoice_date) out.push(disagree("due_after_invoice", "Due date is before the invoice date"));
      break;
    }
    case "account_code": {
      const code = ref.account_codes.find((a) => a.code === value);
      out.push(code ? agree("account_code_valid", `${code.code} ${code.name}`) : disagree("account_code_valid", `${value} is not in the chart of accounts`));
      const supplier = findSupplier(bill.supplier_name, ref);
      if (supplier && supplier.default_account_code !== value) out.push(disagree("account_code_usual", `${supplier.name} is usually coded ${supplier.default_account_code}`));
      break;
    }
    case "property": {
      if (!value) return out;
      const known = ref.tenancies.find((t) => canonical("text", t.property) === canonical("text", value));
      out.push(known ? agree("property_known", "Managed property") : disagree("property_known", "Not a managed property in the tenancy register"));
      break;
    }
  }
  return out;
}

export type ReplyCheckContext = {
  facts: LocatedFact[];
  ref: ReferenceData;
  ownNames: string[];
  tenancy: Tenancy | null;
  senderEmail: string | null;
  today: string;
  refYear: number;
  body: string;
  /** Spans of commitment claims, so promised dates can be checked. */
  commitmentSpans: { start: number; end: number }[];
};

export function replyCodedChecks(type: ClaimType, value: string, span: { start: number; end: number } | null, ctx: ReplyCheckContext): Check[] {
  const out: Check[] = [];
  switch (type) {
    case "date": {
      const p = parseDate(value, ctx.refYear);
      if (!p) return [disagree("date_valid", `"${value}" is not a valid date`)];
      if (p.statedWeekday != null) {
        out.push(p.statedWeekday === weekdayOf(p.iso) ? agree("weekday_matches", "Weekday matches the date") : disagree("weekday_matches", `${formatDate(p.iso)}: the draft says ${WEEKDAY_NAMES[p.statedWeekday]}`));
      }
      // The same date in the source, written with a wrong weekday?
      for (const f of ctx.facts.filter((f) => f.kind === "date")) {
        const s = parseDate(f.value, ctx.refYear);
        if (s && s.iso === p.iso && s.statedWeekday != null && s.statedWeekday !== weekdayOf(s.iso)) {
          out.push(disagree("weekday_matches", `Source says "${f.value}", but ${formatDate(s.iso).slice(4)} is a ${WEEKDAY_NAMES[weekdayOf(s.iso)]}`));
        }
        if (s && s.iso === p.iso && s.ambiguous) out.push(disagree("date_unambiguous", `Source writes ${f.value}, which could be read either way`));
      }
      const inPromise = span && ctx.commitmentSpans.some((c) => span.start >= c.start && span.end <= c.end);
      if (p.iso < ctx.today) out.push(inPromise ? disagree("promise_not_past", `Promised date ${formatDate(p.iso)} is in the past`) : info("date_in_past", `${formatDate(p.iso)} is in the past`));
      else if (inPromise && p.iso > addDays(ctx.today, 60)) out.push(info("promise_far_future", "Promise more than 60 days out"));
      break;
    }
    case "amount": {
      const cents = parseMoney(value);
      if (cents == null) return [disagree("amount_parses", `"${value}" is not an amount`)];
      const t = ctx.tenancy;
      if (t) {
        if (parseMoney(t.rent_weekly) === cents) out.push(agree("tenancy_register", `Weekly rent in the tenancy register for ${t.tenant_name}`));
        else if (parseMoney(t.bond) === cents) out.push(agree("tenancy_register", `Bond in the tenancy register for ${t.tenant_name}`));
      }
      break;
    }
    case "name": {
      if (ctx.ownNames.some((n) => n.toLowerCase() === value.toLowerCase())) {
        out.push(agree("own_name", "Our own name"));
        break;
      }
      const full = ctx.ref.tenancies.map((t) => t.tenant_name);
      const firsts = full.map((n) => n.split(/\s+/)[0]);
      const isFirst = !/\s/.test(value.trim());
      const m = matchName(value, isFirst ? firsts : full);
      const tenancyFor = (n: string) => ctx.ref.tenancies.find((t) => (isFirst ? t.tenant_name.split(/\s+/)[0] : t.tenant_name) === n);
      if (m.kind === "exact") {
        const t = tenancyFor(m.name);
        const sameSender = t && ctx.senderEmail && t.email.toLowerCase() === ctx.senderEmail;
        out.push(sameSender || !ctx.senderEmail ? agree("tenancy_register", `Tenant in register: ${t?.tenant_name}`) : info("tenancy_register", `${t?.tenant_name} is in the register, with a different email`));
      } else if (m.kind === "near") {
        out.push(disagree("tenancy_register", `Near-match only: the tenancy register has "${tenancyFor(m.name)?.tenant_name ?? m.name}"`));
      } else {
        const contact = ctx.ref.contacts.find((c) => matchName(value, [c.name]).kind === "exact");
        out.push(contact ? agree("known_contact", `Known contact: ${contact.name}`) : info("tenancy_register", "Not in the tenancy register or contacts"));
      }
      break;
    }
    case "email": {
      const v = value.toLowerCase();
      const known = ctx.ref.tenancies.some((t) => t.email.toLowerCase() === v) || ctx.ref.contacts.some((c) => c.email.toLowerCase() === v);
      out.push(known ? agree("known_contact", "Known tenant or contact") : disagree("known_contact", `${value} is not a known tenant or contact`));
      break;
    }
    case "address": {
      const known = ctx.ref.tenancies.find((t) => t.property.toLowerCase().includes(value.toLowerCase()));
      out.push(known ? agree("tenancy_register", `Managed property: ${known.property}`) : disagree("tenancy_register", "Not a managed property"));
      break;
    }
  }
  return out;
}

/** Reply recipients must be the sender of the source email (or known contacts). */
export function recipientChecks(to: string[], senderEmail: string | null, ref: ReferenceData): Check[] {
  const out: Check[] = [];
  const known = (e: string) => ref.tenancies.some((t) => t.email.toLowerCase() === e) || ref.contacts.some((c) => c.email.toLowerCase() === e);
  const bad = to.filter((e) => e.toLowerCase() !== senderEmail && !known(e.toLowerCase()));
  out.push(bad.length === 0 && to.length > 0 ? agree("recipients_match_sender", `Replying to ${to.join(", ")}`) : disagree("recipients_match_sender", `Unexpected recipients: ${bad.join(", ") || "none"}`));
  if (senderEmail) out.push(known(senderEmail) ? agree("known_contact", "Sender is a known tenant or contact") : disagree("known_contact", `${senderEmail} is not a known tenant or contact`));
  return out;
}
