// Runs fixtures through the pipeline and checks each planted error against the answer key.
import type { Check, ClaimType, DraftContent } from "@vc/shared";
import { answerKeys, type Expectation, type FixtureKey } from "../../../fixtures/data";
import { groupFor } from "../src/pipeline/claims";
import { ingest, rows, type TestEnv } from "./helpers";

type ClaimRec = { type: ClaimType; field: string | null; value_true: string; checks: Check[]; model_verdict: string | null; group_name: string };

export type PlantedResult = { id: string; description: string; flagged: boolean; evidence: string };
export type FixtureResult = {
  key: FixtureKey;
  taskId: string;
  status: string;
  tier: number;
  tierReasons: string[];
  planted: PlantedResult[];
  otherFindings: string[];
  models: string[];
};

function evaluate(e: Expectation, claims: ClaimRec[], content: DraftContent, task: { tier_reasons: string[]; needs_licensed_reviewer: number }): { ok: boolean; evidence: string } {
  switch (e.kind) {
    case "check": {
      const hit = claims.find((c) => (!e.field || c.field === e.field) && c.checks.some((k) => k.check === e.check && k.result === "disagree"));
      return hit ? { ok: true, evidence: `${hit.field ?? hit.type}: ${hit.checks.find((k) => k.check === e.check && k.result === "disagree")!.detail}` } : { ok: false, evidence: `no disagreeing ${e.check} check` };
    }
    case "group": {
      const hit = claims.find(
        (c) =>
          groupFor({ type: c.type, checks: c.checks, model_verdict: c.model_verdict }, false) === e.group &&
          (!e.claimType || c.type === e.claimType) &&
          (!e.contains || c.value_true.toLowerCase().includes(e.contains.toLowerCase())),
      );
      return hit ? { ok: true, evidence: `${e.group}: "${hit.value_true}"` } : { ok: false, evidence: `no ${e.group} claim` };
    }
    case "tier_reason": {
      const r = task.tier_reasons.find((x) => x.startsWith(`${e.reason}:`));
      return r ? { ok: true, evidence: r } : { ok: false, evidence: `tier reasons: ${task.tier_reasons.join("; ")}` };
    }
    case "draft_excludes": {
      const text = JSON.stringify(content).toLowerCase();
      const found = e.texts.filter((t) => text.includes(t.toLowerCase()));
      return found.length ? { ok: false, evidence: `draft contains ${found.join(", ")}` } : { ok: true, evidence: "none of the injected content is in the draft" };
    }
    case "recipients": {
      const to = content.kind === "reply" ? content.reply.to : [];
      return JSON.stringify(to) === JSON.stringify(e.to) ? { ok: true, evidence: `to: ${to.join(", ")}` } : { ok: false, evidence: `to: ${to.join(", ")}` };
    }
    case "licensed_reviewer":
      return task.needs_licensed_reviewer ? { ok: true, evidence: "second review restricted to licensed APN reviewers" } : { ok: false, evidence: "not restricted" };
  }
}

export async function runFixture(env: TestEnv, key: FixtureKey): Promise<FixtureResult> {
  const taskId = await ingest(env, key.id);
  const t = rows<{ status: string; tier: number; tier_reasons_json: string; needs_licensed_reviewer: number; current_draft_id: string }>(env, "SELECT * FROM tasks WHERE id = ?", taskId)[0];
  const draft = rows<{ content_json: string }>(env, "SELECT content_json FROM drafts WHERE id = ?", t.current_draft_id)[0];
  const claims = rows<ClaimRec & { checks_json: string }>(env, "SELECT * FROM claims WHERE draft_id = ?", t.current_draft_id).map((c) => ({ ...c, checks: JSON.parse(c.checks_json) as Check[] }));
  const content = JSON.parse(draft.content_json) as DraftContent;
  const tierReasons = JSON.parse(t.tier_reasons_json) as string[];
  const planted = key.planted.map((p) => {
    const r = evaluate(p.expect, claims, content, { tier_reasons: tierReasons, needs_licensed_reviewer: t.needs_licensed_reviewer });
    return { id: p.id, description: p.description, flagged: r.ok, evidence: r.evidence };
  });
  const otherFindings = claims
    .filter((c) => c.group_name !== "matched" && c.group_name !== "rekey")
    .map((c) => `${c.group_name}: ${c.field ?? c.type} "${c.value_true.slice(0, 60)}"`)
    .concat(claims.flatMap((c) => c.checks.filter((k) => k.result === "disagree" && c.group_name === "rekey").map((k) => `rekey+${k.check}: ${c.field ?? c.type}`)));
  const models = [...new Set(rows<{ model: string; prompt_version: string }>(env, "SELECT model, prompt_version FROM model_calls WHERE task_id = ?", taskId).map((m) => `${m.model} (${m.prompt_version})`))];
  return { key, taskId, status: t.status, tier: t.tier, tierReasons, planted, otherFindings, models };
}

export async function runAllFixtures(env: TestEnv): Promise<FixtureResult[]> {
  const out: FixtureResult[] = [];
  for (const key of answerKeys()) out.push(await runFixture(env, key));
  return out;
}

export function reportMarkdown(results: FixtureResult[], mode: string, when: string): string {
  const planted = results.flatMap((r) => r.planted);
  const flagged = planted.filter((p) => p.flagged).length;
  const tierOk = results.filter((r) => r.tier === r.key.expected_tier).length;
  const lines = [
    "# Fixture report",
    "",
    `Run: ${when} · model mode: **${mode}** · ${results.length} fixtures, all run end to end through the pipeline.`,
    "",
    `**Planted errors flagged: ${flagged} of ${planted.length}.** Tier as expected: ${tierOk} of ${results.length}.`,
    "",
    mode === "offline"
      ? "> Offline mode uses the deterministic stand-in model, so this run measures the coded checks, tiering and plumbing, not model quality. Re-run with `MODEL_MODE=anthropic` and an API key for that."
      : "> Live mode: model stages ran on the Claude API with the models in `apps/api/src/model/config.ts`.",
    "",
    "| Fixture | What it tests | Tier (expected) | Planted error | Flagged | Evidence |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    const tier = `${r.tier} (${r.key.expected_tier})${r.tier === r.key.expected_tier ? "" : " ⚠"}`;
    if (!r.planted.length) {
      lines.push(`| ${r.key.id} | ${r.key.summary} | ${tier} | (control: none planted) | n/a | ${r.status} |`);
      continue;
    }
    r.planted.forEach((p, i) => {
      lines.push(`| ${i === 0 ? r.key.id : ""} | ${i === 0 ? r.key.summary : ""} | ${i === 0 ? tier : ""} | ${p.description} | ${p.flagged ? "✅ yes" : "❌ no"} | ${p.evidence.replace(/\|/g, "/")} |`);
    });
  }
  lines.push("", "## Everything else each fixture raised", "", "Findings beyond the planted errors (expected for unsupported promises and policy statements in replies).", "");
  for (const r of results) lines.push(`- **${r.key.id}**: ${r.otherFindings.length ? r.otherFindings.join("; ") : "nothing else"}`);
  lines.push("", "## Models", "");
  for (const m of [...new Set(results.flatMap((r) => r.models))]) lines.push(`- ${m}`);
  return lines.join("\n") + "\n";
}
