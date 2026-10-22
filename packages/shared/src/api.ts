// Shapes returned by the API to the web app.
import type {
  Check,
  ClaimGroup,
  ClaimStatus,
  ClaimType,
  DraftContent,
  Flags,
  Role,
  TaskStatus,
  TaskType,
} from "./schemas";

export type Me = {
  email: string;
  name: string;
  role: Role;
  licensed_apn: boolean;
  clients: { id: string; name: string }[];
};

export type PdfTextItem = { s: number; e: number; x: number; y: number; w: number; h: number };
export type PdfPage = { index: number; width: number; height: number; start: number; end: number; items: PdfTextItem[] };

export type SourceView =
  | { kind: "pdf"; filename: string; text: string; pages: PdfPage[]; url: string }
  | { kind: "email"; text: string; quotedFrom: number | null };

export type ClaimView = {
  id: string;
  type: ClaimType;
  label: string;
  field: string | null; // bill field, or null for reply text
  group: ClaimGroup;
  status: ClaimStatus;
  needs_rekey: boolean;
  rekey_pending: boolean; // value hidden until typed
  rekey_mismatch: boolean;
  /** Displayed draft value; null while a re-key is pending. */
  draft_value: string | null;
  /** Value found in the source; null while a re-key is pending or when not found. */
  source_value: string | null;
  draft_span: { start: number; end: number } | null; // in the displayed reply body
  source_span: { start: number; end: number } | null;
  checks: Check[];
  last_decision: { action: string; by: string; at: string; note: string | null } | null;
};

export type TaskSummary = {
  id: string;
  client_id: string;
  client_name: string;
  type: TaskType;
  tier: number;
  status: TaskStatus;
  created_at: string;
  title: string;
};

export type TaskView = TaskSummary & {
  tier_reasons: string[];
  lock: { holder: string | null; expires_at: string | null; mine: boolean };
  source: SourceView;
  draft: { id: string; version: number; content: DraftContent };
  /** In the displayed draft, spans that must be masked (re-key pending). */
  masked_spans: { start: number; end: number }[];
  claims: ClaimView[];
  open_claims: number;
  flags: Flags;
  operator_approval: { by: string; at: string } | null;
  needs_licensed_reviewer: boolean;
  release: { id: string; at: string } | null;
  /** The client's own record this item relates to (tenancy or supplier), for checking values the source doesn't state. */
  reference: { title: string; rows: [string, string][] } | null;
};

export type ApproveResult =
  | { outcome: "released"; release_id: string }
  | { outcome: "second_review" }
  | { outcome: "held"; missed: { label: string; shown: string; actual: string } }
  | { outcome: "blocked"; reasons: string[] };

export type DecisionResult = {
  ok: true;
  claim: ClaimView | null;
  canary: "caught" | null;
  task: TaskView;
};
