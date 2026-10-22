// Intake: Phase 0 accepts an uploaded PDF bill or a pasted email. Gmail intake waits on its flag.
import { HTTPException } from "hono/http-exception";
import { audit } from "./lib/audit";
import { canSeeClient } from "./lib/auth";
import { nowIso } from "./lib/clock";
import { first, newId, stmt } from "./lib/db";
import type { Actor, Env } from "./lib/env";
import { startPipeline } from "./pipeline/run";
import { extractPdf, parseEmail, sha256Hex } from "./pipeline/source";

export const MAX_PDF_BYTES = 10 * 1024 * 1024;

export type IntakeInput =
  | { client_id: string; type: "supplier_bill"; pdf: { filename: string; bytes: Uint8Array } }
  | { client_id: string; type: "tenant_email"; email: string };

export async function createTask(env: Env, actor: Actor, input: IntakeInput): Promise<string> {
  if (!["operator", "senior", "admin"].includes(actor.role)) throw new HTTPException(403, { message: "Not allowed to add work" });
  if (!(await first(env.DB, "SELECT 1 AS ok FROM clients WHERE id = ?", input.client_id))) throw new HTTPException(404, { message: "Unknown client" });
  if (!(await canSeeClient(env, actor, input.client_id))) throw new HTTPException(403, { message: "You're not assigned to this client" });

  const taskId = newId("tk");
  const ts = nowIso(env);
  let sourceStmt: D1PreparedStatement;
  let title: string;
  if (input.type === "supplier_bill") {
    const { bytes, filename } = input.pdf;
    if (bytes.byteLength > MAX_PDF_BYTES) throw new HTTPException(413, { message: "PDF is over 10 MB" });
    if (new TextDecoder().decode(bytes.slice(0, 5)) !== "%PDF-") throw new HTTPException(400, { message: "That file isn't a PDF" });
    const extracted = await extractPdf(bytes);
    if (!extracted.text.trim()) throw new HTTPException(422, { message: "This PDF has no text layer (a scan?). Scanned bills aren't supported in Phase 0." });
    const hash = await sha256Hex(bytes);
    const key = `sources/${taskId}/${hash}.pdf`;
    await env.FILES.put(key, bytes, { httpMetadata: { contentType: "application/pdf" } });
    title = filename;
    sourceStmt = stmt(
      env.DB,
      "INSERT INTO source_documents (id, task_id, kind, filename, content_hash, r2_key, text, layout_json, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      newId("sd"),
      taskId,
      "pdf",
      filename,
      hash,
      key,
      extracted.text,
      JSON.stringify(extracted.pages),
      null,
      ts,
    );
  } else {
    if (!input.email.trim()) throw new HTTPException(400, { message: "Paste the email" });
    if (input.email.length > 200_000) throw new HTTPException(413, { message: "Email is too long" });
    const { text, meta } = parseEmail(input.email);
    title = meta.subject ? `${meta.from_name ?? meta.from_email ?? "Email"}: ${meta.subject}` : "Pasted email";
    sourceStmt = stmt(
      env.DB,
      "INSERT INTO source_documents (id, task_id, kind, filename, content_hash, r2_key, text, layout_json, meta_json, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      newId("sd"),
      taskId,
      "email",
      null,
      await sha256Hex(text),
      null,
      text,
      null,
      JSON.stringify(meta),
      ts,
    );
  }
  await env.DB.batch([
    stmt(
      env.DB,
      "INSERT INTO tasks (id, client_id, type, title, tier, tier_reasons_json, status, created_by, created_at, updated_at) VALUES (?,?,?,?,1,'[]','processing',?,?,?)",
      taskId,
      input.client_id,
      input.type,
      title.slice(0, 200),
      actor.email,
      ts,
      ts,
    ),
    sourceStmt,
  ]);
  await audit(env, actor.email, taskId, "intake", { type: input.type, via: "upload" });
  await startPipeline(env, taskId);
  return taskId;
}
