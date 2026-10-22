// The AI pipeline. Each stage is one queue message, so a failed stage retries alone.
// All model work happens here, before an operator sees the item.
import { locateQuote, type DraftContent, type LocatedFact, type TaskType } from "@vc/shared";
import { audit } from "../lib/audit";
import { now, nowIso, todayIso } from "../lib/clock";
import { newId, parseJson, run, stmt } from "../lib/db";
import type { Env, PipelineMessage, PipelineStage } from "../lib/env";
import {
  clientFlags,
  getClient,
  getDraft,
  getFacts,
  getPlaybook,
  getReference,
  getSource,
  getTask,
  taskTierReasons,
  type TaskRow,
} from "../lib/repo";
import { getModel, logged } from "../model";
import { pickCanary, rng, saveDraftVersion, shouldSeed } from "../verify/drafts";
import { checkCandidates, listCandidates, regroup, type BuiltClaim, type Candidate, type ClaimContext } from "./claims";
import { draftTierRules, factTierRules, findTenancy, mergeTier, sourceTierRules, type TierResult } from "./rules";
import type { EmailMeta } from "./source";

const NEXT: Record<PipelineStage, PipelineStage | null> = {
  classify: "extract",
  extract: "draft",
  draft: "claims",
  claims: "check",
  check: "queue",
  queue: null,
};

export const MAX_ATTEMPTS = 3;

export async function enqueue(env: Env, taskId: string, stage: PipelineStage) {
  await run(env.DB, "UPDATE tasks SET stage = ?, updated_at = ? WHERE id = ?", stage, nowIso(env), taskId);
  await env.PIPELINE.send({ taskId, stage });
}

async function setTier(env: Env, task: TaskRow, t: Partial<TierResult>) {
  const current: TierResult = { tier: task.tier, reasons: taskTierReasons(task), licensed: !!task.needs_licensed_reviewer };
  const next = mergeTier(current, t); // tier can only go up
  await run(env.DB, "UPDATE tasks SET tier = ?, tier_reasons_json = ?, needs_licensed_reviewer = ?, updated_at = ? WHERE id = ?", next.tier, JSON.stringify(next.reasons), next.licensed ? 1 : 0, nowIso(env), task.id);
  task.tier = next.tier;
  task.tier_reasons_json = JSON.stringify(next.reasons);
  task.needs_licensed_reviewer = next.licensed ? 1 : 0;
}

export async function claimContext(env: Env, task: TaskRow): Promise<ClaimContext> {
  const source = (await getSource(env, task.id))!;
  const meta = parseJson<EmailMeta | null>(source.meta_json, null);
  const facts = await getFacts(env, task.id);
  const ref = await getReference(env, task.client_id);
  const { playbook } = await getPlaybook(env, task.client_id, task.type);
  const senderEmail = meta?.from_email ?? null;
  return {
    env,
    model: getModel(env),
    taskId: task.id,
    taskType: task.type,
    sourceText: source.text,
    facts,
    ref,
    playbook,
    tenancy: task.type === "tenant_email" ? findTenancy(ref, senderEmail, facts) : null,
    senderEmail,
    today: todayIso(env),
    refYear: now(env).getUTCFullYear(),
  };
}

export async function runStage(env: Env, msg: PipelineMessage): Promise<void> {
  const task = await getTask(env, msg.taskId);
  if (!task || task.status !== "processing") return; // stale message
  const model = getModel(env);
  const source = (await getSource(env, task.id))!;
  const meta = parseJson<EmailMeta | null>(source.meta_json, null);
  const ref = await getReference(env, task.client_id);

  switch (msg.stage) {
    case "classify": {
      // 1. Coded rules set the tier first; the model may only raise it.
      await setTier(env, task, sourceTierRules(task.type, source.text, meta?.from_email ?? null, ref));
      const res = await logged(env, task.id, "classify", model.mode, { type: task.type }, () => model.classify({ taskType: task.type, sourceText: source.text }));
      const raised = Math.min(3, Math.max(1, Math.round(res.output.tier)));
      if (raised > task.tier) await setTier(env, task, { tier: raised, reasons: res.output.reasons.map((r) => `model: ${r}`) });
      break;
    }
    case "extract": {
      // 2. The source alone goes in. Facts whose quote can't be found are discarded.
      const res = await logged(env, task.id, "extract", model.mode, { type: task.type }, () => model.extract({ taskType: task.type, sourceText: source.text }));
      const stmts = [stmt(env.DB, "DELETE FROM facts WHERE task_id = ?", task.id)];
      let discarded = 0;
      const located: LocatedFact[] = [];
      for (const f of res.output.facts) {
        const span = locateQuote(source.text, f.quote);
        if (!span) {
          discarded++;
          continue;
        }
        const id = newId("fa");
        located.push({ ...f, id, span });
        stmts.push(stmt(env.DB, "INSERT INTO facts (id, task_id, kind, label, value, quote, span_start, span_end) VALUES (?,?,?,?,?,?,?,?)", id, task.id, f.kind, f.label, f.value, f.quote, span.start, span.end));
      }
      await env.DB.batch(stmts);
      if (discarded) await audit(env, "system", task.id, "facts_discarded", { count: discarded, reason: "quote not found in source" });
      const client = (await getClient(env, task.client_id))!;
      await setTier(env, task, factTierRules(task.type, located, ref, client.tier3_threshold_cents));
      break;
    }
    case "draft": {
      // 3. Extracted facts plus the playbook produce the output. The drafter never sees the raw source.
      const ctx = await claimContext(env, task);
      const { id: playbookId, playbook } = await getPlaybook(env, task.client_id, task.type);
      let content: DraftContent;
      let modelName: string;
      let promptVersion: string;
      if (task.type === "supplier_bill") {
        const res = await logged(env, task.id, "draft", model.mode, { facts: ctx.facts.length }, () =>
          model.draftBill({ facts: ctx.facts, playbook, reference: ref, redraftNote: task.redraft_note }),
        );
        content = { kind: "bill", bill: res.output };
        modelName = res.model;
        promptVersion = res.promptVersion;
      } else {
        const res = await logged(env, task.id, "draft", model.mode, { facts: ctx.facts.length }, () =>
          model.draftReply({ facts: ctx.facts, playbook, tenancy: ctx.tenancy, senderName: meta?.from_name ?? null, subject: meta?.subject ?? null, redraftNote: task.redraft_note }),
        );
        // Recipients and subject are set by code, never by a model.
        const subject = meta?.subject ? (/^re:/i.test(meta.subject) ? meta.subject : `Re: ${meta.subject}`) : "Re: your email";
        content = { kind: "reply", reply: { to: meta?.from_email ? [meta.from_email] : [], subject, body: res.output.body } };
        modelName = res.model;
        promptVersion = res.promptVersion;
      }
      await run(env.DB, "UPDATE tasks SET playbook_id = ?, pipeline_json = ? WHERE id = ?", playbookId, JSON.stringify({ content, model: modelName, promptVersion }), task.id);
      break;
    }
    case "claims": {
      // 4. List the draft's claims (model listing plus coded sweep).
      const pj = parseJson<{ content: DraftContent; model: string; promptVersion: string }>(task.pipeline_json ?? null, null as never);
      const ctx = await claimContext(env, task);
      const candidates = await listCandidates(ctx, pj.content);
      await run(env.DB, "UPDATE tasks SET pipeline_json = ? WHERE id = ?", JSON.stringify({ ...pj, candidates }), task.id);
      break;
    }
    case "check": {
      // 5 and 6. Independent check plus coded checks.
      const pj = parseJson<{ content: DraftContent; model: string; promptVersion: string; candidates: Candidate[] }>(task.pipeline_json ?? null, null as never);
      const ctx = await claimContext(env, task);
      const built = await checkCandidates(ctx, pj.content, pj.candidates, task.tier);
      await run(env.DB, "UPDATE tasks SET pipeline_json = ? WHERE id = ?", JSON.stringify({ ...pj, built }), task.id);
      break;
    }
    case "queue": {
      // 7. Store the item, its claims and check results, then queue it for an operator.
      const pj = parseJson<{ content: DraftContent; model: string; promptVersion: string; built: BuiltClaim[] }>(task.pipeline_json ?? null, null as never);
      if (task.type === "tenant_email") await setTier(env, task, draftTierRules(pj.built.map((c) => c.type)));
      if (pj.built.some((c) => c.checks.some((k) => k.check === "bank_details_match" && k.result === "disagree"))) {
        await setTier(env, task, { tier: 3, reasons: ["bank_details_changed: Supplier bank details differ from our record"] });
      }
      const built = pj.built.map((c) => regroup(c, task.tier));
      const client = (await getClient(env, task.client_id))!;
      const rand = rng(`${task.id}:${task.updated_at}`);
      const canary = shouldSeed(env, client.seeded_rate, clientFlags(client).seeded_errors, rand) ? pickCanary(built, rand) : null;
      const prev = await getDraft(env, task.current_draft_id);
      await saveDraftVersion(env, {
        taskId: task.id,
        version: (prev?.version ?? 0) + 1,
        content: pj.content,
        author: "model",
        model: pj.model,
        promptVersion: pj.promptVersion,
        parentId: prev?.id ?? null,
        claims: built,
        canary,
      });
      const ts = nowIso(env);
      await run(env.DB, "UPDATE tasks SET status = 'queued', stage = NULL, queued_at = ?, pipeline_json = NULL, redraft_note = NULL, updated_at = ? WHERE id = ?", ts, ts, task.id);
      await audit(env, "system", task.id, "queued", { tier: task.tier, claims: built.length });
      break;
    }
  }
  const next = NEXT[msg.stage];
  if (next) await enqueue(env, task.id, next);
}

/** Queue consumer: retry a failed stage alone; after MAX_ATTEMPTS mark the task as errored. */
export async function handleBatch(batch: MessageBatch<PipelineMessage>, env: Env) {
  for (const m of batch.messages) {
    try {
      await runStage(env, m.body);
      m.ack();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (m.attempts >= MAX_ATTEMPTS) {
        await run(env.DB, "UPDATE tasks SET status = 'error', error = ?, updated_at = ? WHERE id = ?", `${m.body.stage}: ${message}`, nowIso(env), m.body.taskId);
        await audit(env, "system", m.body.taskId, "pipeline_error", { stage: m.body.stage, message });
        m.ack();
      } else {
        m.retry({ delaySeconds: 5 * m.attempts });
      }
    }
  }
}

export async function startPipeline(env: Env, taskId: string) {
  await enqueue(env, taskId, "classify");
}

export type { TaskType };
