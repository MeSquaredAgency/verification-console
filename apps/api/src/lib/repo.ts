// Loading the pieces of a task that pipeline stages and verification need.
import type { DraftContent, Flags, LocatedFact, Playbook, ReferenceData, TaskType } from "@vc/shared";
import { all, first, parseJson } from "./db";
import type { Env } from "./env";
import { resolveFlags } from "./flags";

export type TaskRow = {
  id: string;
  client_id: string;
  type: TaskType;
  title: string;
  tier: number;
  tier_reasons_json: string;
  status: string;
  stage: string | null;
  error: string | null;
  playbook_id: string | null;
  current_draft_id: string | null;
  redraft_note: string | null;
  needs_licensed_reviewer: number;
  lock_holder: string | null;
  lock_expires_at: string | null;
  operator_approved_by: string | null;
  operator_approved_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  queued_at: string | null;
  pipeline_json: string | null;
};

export type ClientRow = {
  id: string;
  name: string;
  tier3_threshold_cents: number;
  seeded_rate: number;
  retention_days: number;
  spot_check_floor_ms: number | null;
  flags_json: string;
};

export type SourceRow = {
  id: string;
  task_id: string;
  kind: "pdf" | "email";
  filename: string | null;
  content_hash: string;
  r2_key: string | null;
  text: string;
  layout_json: string | null;
  meta_json: string | null;
};

export type DraftRow = {
  id: string;
  task_id: string;
  version: number;
  content_json: string;
  display_json: string | null;
  author: string;
  model: string | null;
  prompt_version: string | null;
  parent_id: string | null;
  created_at: string;
};

export type ClaimRow = {
  id: string;
  task_id: string;
  draft_id: string;
  ord: number;
  claim_key: string;
  type: string;
  label: string;
  field: string | null;
  value_true: string;
  value_display: string;
  start: number | null;
  end: number | null;
  true_start: number | null;
  true_end: number | null;
  source_value: string | null;
  source_start: number | null;
  source_end: number | null;
  checks_json: string;
  model_verdict: string | null;
  group_name: string;
  needs_rekey: number;
  rekeyed: number;
  rekey_mismatch: number;
  status: string;
  prev_claim_id: string | null;
  created_at: string;
  updated_at: string;
};

export async function getTask(env: Env, id: string) {
  return first<TaskRow>(env.DB, "SELECT * FROM tasks WHERE id = ?", id);
}

export async function getClient(env: Env, id: string) {
  return first<ClientRow>(env.DB, "SELECT * FROM clients WHERE id = ?", id);
}

export async function getSource(env: Env, taskId: string) {
  return first<SourceRow>(env.DB, "SELECT * FROM source_documents WHERE task_id = ?", taskId);
}

export async function getDraft(env: Env, id: string | null) {
  return id ? first<DraftRow>(env.DB, "SELECT * FROM drafts WHERE id = ?", id) : null;
}

export async function getClaims(env: Env, draftId: string) {
  return all<ClaimRow>(env.DB, "SELECT * FROM claims WHERE draft_id = ? ORDER BY ord", draftId);
}

export async function getFacts(env: Env, taskId: string): Promise<LocatedFact[]> {
  const rows = await all<{ id: string; kind: string; label: string; value: string; quote: string; span_start: number; span_end: number }>(
    env.DB,
    "SELECT * FROM facts WHERE task_id = ? ORDER BY span_start",
    taskId,
  );
  return rows.map((f) => ({ id: f.id, kind: f.kind as LocatedFact["kind"], label: f.label, value: f.value, quote: f.quote, span: { start: f.span_start, end: f.span_end } }));
}

export async function getPlaybook(env: Env, clientId: string, type: TaskType) {
  const row = await first<{ id: string; content_json: string; version: number }>(
    env.DB,
    "SELECT id, content_json, version FROM playbooks WHERE client_id = ? AND task_type = ? AND active = 1 ORDER BY version DESC LIMIT 1",
    clientId,
    type,
  );
  if (!row) throw new Error(`No active playbook for ${clientId}/${type}`);
  return { id: row.id, version: row.version, playbook: JSON.parse(row.content_json) as Playbook };
}

export async function getReference(env: Env, clientId: string): Promise<ReferenceData> {
  const rows = await all<{ kind: string; data_json: string }>(env.DB, "SELECT kind, data_json FROM reference_records WHERE client_id = ? ORDER BY key", clientId);
  const ref: ReferenceData = { suppliers: [], tenancies: [], contacts: [], account_codes: [] };
  for (const r of rows) {
    const d = JSON.parse(r.data_json);
    if (r.kind === "supplier") ref.suppliers.push(d);
    else if (r.kind === "tenancy") ref.tenancies.push(d);
    else if (r.kind === "contact") ref.contacts.push(d);
    else if (r.kind === "account_code") ref.account_codes.push(d);
  }
  return ref;
}

export function draftContent(d: DraftRow, which: "true" | "display"): DraftContent {
  return JSON.parse(which === "display" && d.display_json ? d.display_json : d.content_json) as DraftContent;
}

export function clientFlags(client: ClientRow): Flags {
  return resolveFlags(client.flags_json);
}

export function taskTierReasons(t: TaskRow): string[] {
  return parseJson<string[]>(t.tier_reasons_json, []);
}
