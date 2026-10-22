import { app } from "./app";
import { audit } from "./lib/audit";
import { now, nowIso } from "./lib/clock";
import { all, run } from "./lib/db";
import type { Env, PipelineMessage } from "./lib/env";
import { handleBatch } from "./pipeline/run";

/** Retention: purge source files after the client's agreed period; the audit record keeps hashes. */
export async function purgeExpiredSources(env: Env) {
  const rows = await all<{ id: string; task_id: string; r2_key: string | null; created_at: string; retention_days: number }>(
    env.DB,
    `SELECT s.id, s.task_id, s.r2_key, s.created_at, c.retention_days FROM source_documents s
     JOIN tasks t ON t.id = s.task_id JOIN clients c ON c.id = t.client_id WHERE s.purged_at IS NULL`,
  );
  const nowMs = now(env).getTime();
  for (const r of rows) {
    if (Date.parse(r.created_at) + r.retention_days * 86400_000 > nowMs) continue;
    if (r.r2_key) await env.FILES.delete(r.r2_key);
    await run(env.DB, "UPDATE source_documents SET text = '', layout_json = NULL, meta_json = NULL, purged_at = ? WHERE id = ?", nowIso(env), r.id);
    await run(env.DB, "UPDATE facts SET value = '', quote = '' WHERE task_id = ?", r.task_id);
    await audit(env, "system", r.task_id, "source_purged", { source_id: r.id });
  }
}

export default {
  fetch: app.fetch,
  async queue(batch: MessageBatch<PipelineMessage>, env: Env) {
    await handleBatch(batch, env);
  },
  async scheduled(_event: ScheduledController, env: Env) {
    await purgeExpiredSources(env);
  },
} satisfies ExportedHandler<Env, PipelineMessage>;
