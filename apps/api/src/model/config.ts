// Models and effort are set per stage here, not in pipeline code.
// Checked against the Claude API docs on 2026-10-22: current models are claude-opus-5-5,
// claude-sonnet-5-5 and claude-haiku-5-5. `temperature` is no longer accepted by the Messages
// API (400 from 2026-10-21), so determinism comes from structured outputs, effort and code checks.
export type StageName = "classify" | "extract" | "draft" | "list_claims" | "check";

export type StageConfig = {
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  max_tokens: number;
};

export const MODEL_CONFIG: Record<StageName, StageConfig> = {
  classify: { model: "claude-opus-5-5", effort: "low", max_tokens: 4000 },
  extract: { model: "claude-opus-5-5", effort: "medium", max_tokens: 16000 },
  draft: { model: "claude-opus-5-5", effort: "medium", max_tokens: 16000 },
  list_claims: { model: "claude-opus-5-5", effort: "medium", max_tokens: 16000 },
  check: { model: "claude-opus-5-5", effort: "high", max_tokens: 16000 },
};

/** Server-side refusal fallback (Claude API beta). Set to null to disable. */
export const FALLBACK = { beta: "server-side-fallback-2026-07-01", fallbacks: "default" as const };
