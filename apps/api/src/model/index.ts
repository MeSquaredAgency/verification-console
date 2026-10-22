import { nowIso } from "../lib/clock";
import { newId, run } from "../lib/db";
import type { Env } from "../lib/env";
import { sha256Hex } from "../pipeline/source";
import { anthropicModel } from "./anthropic";
import { offlineModel } from "./offline";
import type { ModelResult, StageModel } from "./types";

export function modelMode(env: Env): "anthropic" | "offline" {
  if (env.MODEL_MODE === "offline") return "offline";
  if (env.MODEL_MODE === "anthropic" || env.ANTHROPIC_API_KEY) {
    if (!env.ANTHROPIC_API_KEY) throw new Error("MODEL_MODE=anthropic but ANTHROPIC_API_KEY is not set");
    return "anthropic";
  }
  return "offline";
}

export function getModel(env: Env): StageModel {
  return modelMode(env) === "anthropic" ? anthropicModel(env.ANTHROPIC_API_KEY!) : offlineModel();
}

/** Run one model call and log its model, prompt version and output. */
export async function logged<T>(env: Env, taskId: string, stage: string, mode: string, input: unknown, fn: () => Promise<ModelResult<T>>): Promise<ModelResult<T>> {
  const started = Date.now();
  const res = await fn();
  await run(
    env.DB,
    "INSERT INTO model_calls (id, task_id, stage, mode, model, prompt_version, input_hash, output_json, duration_ms, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    newId("mc"),
    taskId,
    stage,
    mode,
    res.model,
    res.promptVersion,
    await sha256Hex(JSON.stringify(input)),
    JSON.stringify(res.output),
    Date.now() - started,
    nowIso(env),
  );
  return res;
}
