import { z } from "zod";

// ---------- Enums ----------

export const TaskType = z.enum(["supplier_bill", "tenant_email"]);
export type TaskType = z.infer<typeof TaskType>;

export const Role = z.enum(["operator", "senior", "admin", "auditor"]);
export type Role = z.infer<typeof Role>;

export const TaskStatus = z.enum([
  "processing", // AI pipeline running
  "queued", // waiting for an operator
  "in_review", // operator verifying
  "second_review", // waiting for a senior reviewer
  "released",
  "error",
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const ClaimType = z.enum([
  "name",
  "date",
  "amount",
  "number",
  "reference",
  "address",
  "abn",
  "bank",
  "account_code",
  "email",
  "phone",
  "commitment",
  "policy",
  "legal",
  "text",
  "question",
]);
export type ClaimType = z.infer<typeof ClaimType>;

/** Panel 3 grouping, in display order: problems first. */
export const ClaimGroup = z.enum(["rekey", "mismatch", "unsupported", "omitted", "matched"]);
export type ClaimGroup = z.infer<typeof ClaimGroup>;
export const CLAIM_GROUP_ORDER: ClaimGroup[] = ["rekey", "mismatch", "unsupported", "omitted", "matched"];

export const ClaimStatus = z.enum(["undecided", "confirmed", "corrected", "flagged"]);
export type ClaimStatus = z.infer<typeof ClaimStatus>;

export const DecisionAction = z.enum(["confirm", "correct", "flag", "rekey"]);
export type DecisionAction = z.infer<typeof DecisionAction>;

export const CheckResult = z.enum(["agree", "disagree", "not_found", "info"]);
export type CheckResult = z.infer<typeof CheckResult>;

export const Check = z.object({
  check: z.string(), // e.g. "independent_check", "gst_one_eleventh"
  result: CheckResult,
  detail: z.string(),
});
export type Check = z.infer<typeof Check>;

export const SourceSpan = z.object({ start: z.number().int(), end: z.number().int() });
export type SourceSpan = z.infer<typeof SourceSpan>;

// ---------- Model stage outputs (validated with Zod, also sent as JSON schema) ----------

export const ClassifyOutput = z.object({
  tier: z.number().int().describe("1, 2 or 3"),
  reasons: z.array(z.string()),
});
export type ClassifyOutput = z.infer<typeof ClassifyOutput>;

export const FactKind = z.enum([
  "party",
  "amount",
  "date",
  "reference",
  "address",
  "bank",
  "abn",
  "line_item",
  "question",
  "request",
  "statement",
]);
export type FactKind = z.infer<typeof FactKind>;

/**
 * One fact pulled from the source. `quote` must be copied verbatim from the source;
 * code locates it and discards the fact if it cannot be found.
 * Labels used by the pipeline: supplier_name, supplier_abn, invoice_number, invoice_date,
 * due_date, subtotal, gst_amount, total_amount, bank_bsb, bank_account, property,
 * sender_name, sender_email, tenant_name, reference. Line items use the description as label.
 */
export const ExtractedFact = z.object({
  kind: FactKind,
  label: z.string(),
  value: z.string(),
  quote: z.string(),
});
export type ExtractedFact = z.infer<typeof ExtractedFact>;

export const ExtractOutput = z.object({
  facts: z.array(ExtractedFact),
});
export type ExtractOutput = z.infer<typeof ExtractOutput>;

/** A fact after code has located its quote in the source. */
export type LocatedFact = ExtractedFact & { id: string; span: SourceSpan };

export const BILL_FIELDS = [
  "supplier_name",
  "supplier_abn",
  "invoice_number",
  "invoice_date",
  "due_date",
  "total_amount",
  "gst_amount",
  "account_code",
  "property",
  "bank_bsb",
  "bank_account",
  "description",
] as const;
export type BillField = (typeof BILL_FIELDS)[number];

export const BillEntry = z.object({
  supplier_name: z.string().nullable(),
  supplier_abn: z.string().nullable(),
  invoice_number: z.string().nullable(),
  invoice_date: z.string().nullable().describe("ISO date YYYY-MM-DD"),
  due_date: z.string().nullable().describe("ISO date YYYY-MM-DD"),
  total_amount: z.string().nullable().describe("GST-inclusive total, decimal string e.g. 1320.00"),
  gst_amount: z.string().nullable().describe("decimal string e.g. 120.00"),
  account_code: z.string().nullable(),
  property: z.string().nullable(),
  bank_bsb: z.string().nullable(),
  bank_account: z.string().nullable(),
  description: z.string().nullable(),
});
export type BillEntry = z.infer<typeof BillEntry>;

export const ReplyDraft = z.object({
  subject: z.string(),
  body: z.string(),
});
export type ReplyDraft = z.infer<typeof ReplyDraft>;

/** Recipients are set by code (sender of the source email), never by a model. */
export type ReplyContent = ReplyDraft & { to: string[] };

export type DraftContent =
  | { kind: "bill"; bill: BillEntry }
  | { kind: "reply"; reply: ReplyContent };

export const ListedClaim = z.object({
  type: ClaimType,
  text: z.string().describe("exact substring of the draft body"),
  occurrence: z.number().int().describe("1 for the first time this text appears in the body, 2 for the second, ..."),
});
export type ListedClaim = z.infer<typeof ListedClaim>;

export const ListClaimsOutput = z.object({ claims: z.array(ListedClaim) });
export type ListClaimsOutput = z.infer<typeof ListClaimsOutput>;

export const Verdict = z.enum(["supported", "contradicted", "not_found"]);
export type Verdict = z.infer<typeof Verdict>;

export const CheckOutput = z.object({
  verdicts: z.array(
    z.object({
      claim_id: z.string(),
      verdict: Verdict,
      source_quote: z.string().nullable(),
      source_value: z.string().nullable(),
      note: z.string(),
    }),
  ),
  unanswered: z.array(
    z.object({
      quote: z.string().describe("verbatim question or request from the source"),
      summary: z.string(),
    }),
  ),
});
export type CheckOutput = z.infer<typeof CheckOutput>;

// ---------- Playbook / reference data ----------

export const Supplier = z.object({
  name: z.string(),
  abn: z.string(),
  bsb: z.string(),
  account: z.string(),
  default_account_code: z.string(),
});
export type Supplier = z.infer<typeof Supplier>;

export const Tenancy = z.object({
  tenant_name: z.string(),
  email: z.string(),
  property: z.string(),
  rent_weekly: z.string(),
  rent_due_day: z.string(),
  bond: z.string(),
});
export type Tenancy = z.infer<typeof Tenancy>;

export const Contact = z.object({ name: z.string(), email: z.string(), role: z.string() });
export type Contact = z.infer<typeof Contact>;

export const AccountCode = z.object({ code: z.string(), name: z.string() });
export type AccountCode = z.infer<typeof AccountCode>;

export const Playbook = z.object({
  voice_guide: z.string(),
  sign_off: z.string(),
  own_names: z.array(z.string()), // names that are ours (agency, team); not checked against the source
  rules: z.array(z.string()),
  /** Standard answers. A topic applies when any keyword and (if given) any `also` word appear in the question. */
  faq: z.array(
    z.object({ topic: z.string(), keywords: z.array(z.string()), also: z.array(z.string()).optional(), answer: z.string() }),
  ),
});
export type Playbook = z.infer<typeof Playbook>;

export const ReferenceData = z.object({
  suppliers: z.array(Supplier),
  tenancies: z.array(Tenancy),
  contacts: z.array(Contact),
  account_codes: z.array(AccountCode),
});
export type ReferenceData = z.infer<typeof ReferenceData>;

// ---------- Feature flags ----------

export const FLAG_DEFAULTS = {
  gmail_intake: false,
  release_send_live: false,
  seeded_errors: true,
  second_review_tier3: true,
  accounting_integration: false,
  client_verification_report: false,
  khmer_ui_hints: false,
} as const;
export type FlagName = keyof typeof FLAG_DEFAULTS;
export type Flags = Record<FlagName, boolean>;
