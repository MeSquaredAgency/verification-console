import { CLAIM_GROUP_ORDER, DecisionAction, FLAG_DEFAULTS, Playbook, type FlagName, type Me, type TaskSummary } from "@vc/shared";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { audit } from "./lib/audit";
import { authenticate, canSeeClient, requireRole, verifyFileSig } from "./lib/auth";
import { now, nowIso } from "./lib/clock";
import { all, first, newId, parseJson, run } from "./lib/db";
import type { Actor, AppEnv, Env } from "./lib/env";
import { PHASE_GATED, resolveFlags } from "./lib/flags";
import { clientFlags, getClaims, getClient, getSource, getTask, type ClaimRow, type TaskRow } from "./lib/repo";
import { createTask } from "./intake";
import { modelMode } from "./model";
import { seedDemo } from "./seed";
import { approve, reject } from "./verify/approve";
import { decide } from "./verify/decisions";
import { applyEdit } from "./verify/edits";
import { acquireLock, assertCanWork, lockHeldByOther, releaseLock, touchActivity } from "./verify/lock";
import { buildTaskView, isRekeyPending } from "./verify/view";

export const app = new Hono<AppEnv>();

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  if (err instanceof z.ZodError) return c.json({ error: "Invalid request", issues: err.issues }, 400);
  console.error(err);
  return c.json({ error: "Something went wrong" }, 500);
});

app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
});

app.get("/api/health", (c) => c.json({ ok: true, model_mode: modelMode(c.env) }));

// ---------- Local development only ----------

app.post("/api/dev/seed", async (c) => {
  if (c.env.DEV_AUTH !== "1") throw new HTTPException(404, { message: "Not found" });
  return c.json(await seedDemo(c.env));
});

app.get("/api/dev/users", async (c) => {
  if (c.env.DEV_AUTH !== "1") throw new HTTPException(404, { message: "Not found" });
  return c.json(await all(c.env.DB, "SELECT email, name, role FROM users WHERE active = 1 ORDER BY role, email"));
});

// ---------- Signed file URLs (PDF bytes for Panel 1) ----------

app.get("/api/files/:key{.+}", authenticate, async (c) => {
  const key = decodeURIComponent(c.req.param("key"));
  const ok = await verifyFileSig(c.env, key, c.req.query("exp") ?? "0", c.req.query("sig") ?? "", now(c.env).getTime());
  if (!ok) throw new HTTPException(403, { message: "Link expired" });
  const src = await first<{ task_id: string }>(c.env.DB, "SELECT task_id FROM source_documents WHERE r2_key = ?", key);
  const task = src ? await getTask(c.env, src.task_id) : null;
  if (!task || !(await canSeeClient(c.env, c.get("actor"), task.client_id))) throw new HTTPException(404, { message: "Not found" });
  const obj = await c.env.FILES.get(key);
  if (!obj) throw new HTTPException(404, { message: "Not found" });
  await audit(c.env, c.get("actor").email, task.id, "source_viewed", {});
  return new Response(obj.body, { headers: { "Content-Type": "application/pdf", "Content-Disposition": "inline", "Cache-Control": "no-store, private" } });
});

// ---------- Everything below needs a signed-in user ----------

app.use("/api/*", authenticate);

app.get("/api/me", async (c) => {
  const a = c.get("actor");
  const clients =
    a.role === "operator"
      ? await all<{ id: string; name: string }>(c.env.DB, "SELECT c.id, c.name FROM clients c JOIN client_assignments ca ON ca.client_id = c.id WHERE ca.user_email = ? ORDER BY c.name", a.email)
      : await all<{ id: string; name: string }>(c.env.DB, "SELECT id, name FROM clients ORDER BY name");
  const me: Me = { email: a.email, name: a.name, role: a.role, licensed_apn: a.licensed_apn, clients };
  return c.json(me);
});

app.get("/api/me/pacing", async (c) => {
  const row = await first<{ streak_start: string; last_at: string }>(c.env.DB, "SELECT * FROM activity WHERE email = ?", c.get("actor").email);
  const nowMs = now(c.env).getTime();
  const live = row && nowMs - Date.parse(row.last_at) < 10 * 60 * 1000;
  const minutes = live ? Math.floor((nowMs - Date.parse(row!.streak_start)) / 60000) : 0;
  return c.json({ streak_minutes: minutes, break_due: minutes >= 50 });
});

app.post("/api/me/break", async (c) => {
  // Taking a break resets the continuous-verification streak.
  const ts = nowIso(c.env);
  await run(c.env.DB, "UPDATE activity SET streak_start = ?, last_at = ? WHERE email = ?", ts, ts, c.get("actor").email);
  await audit(c.env, c.get("actor").email, null, "break_taken", {});
  return c.json({ ok: true });
});

function summary(t: TaskRow & { client_name: string }): TaskSummary {
  return { id: t.id, client_id: t.client_id, client_name: t.client_name, type: t.type, tier: t.tier, status: t.status as TaskSummary["status"], created_at: t.created_at, title: t.title };
}

// Intake
app.post("/api/tasks", requireRole("operator", "senior", "admin"), async (c) => {
  const ct = c.req.header("Content-Type") ?? "";
  let id: string;
  if (ct.includes("multipart/form-data")) {
    const form = await c.req.formData();
    const file = form.get("file");
    const client_id = String(form.get("client_id") ?? "");
    if (!(file instanceof File)) throw new HTTPException(400, { message: "Attach a PDF" });
    id = await createTask(c.env, c.get("actor"), { client_id, type: "supplier_bill", pdf: { filename: file.name, bytes: new Uint8Array(await file.arrayBuffer()) } });
  } else {
    const body = z.object({ client_id: z.string(), email: z.string() }).parse(await c.req.json());
    id = await createTask(c.env, c.get("actor"), { client_id: body.client_id, type: "tenant_email", email: body.email });
  }
  return c.json({ id }, 201);
});

app.post("/api/intake/gmail", requireRole("admin"), async (c) => {
  const body = z.object({ client_id: z.string() }).parse(await c.req.json());
  const client = await getClient(c.env, body.client_id);
  if (!client || !clientFlags(client).gmail_intake) throw new HTTPException(403, { message: `gmail_intake is off. ${PHASE_GATED.gmail_intake}` });
  throw new HTTPException(501, { message: "Gmail intake is a Phase 1 feature and is not built in Phase 0" });
});

// The queue shows the next item only, never the backlog.
app.get("/api/queue/next", requireRole("operator", "senior", "admin"), async (c) => {
  const a = c.get("actor");
  const ts = nowIso(c.env);
  const mine = await first<TaskRow & { client_name: string }>(
    c.env.DB,
    "SELECT t.*, c.name AS client_name FROM tasks t JOIN clients c ON c.id = t.client_id WHERE t.status = 'in_review' AND t.lock_holder = ? AND t.lock_expires_at > ? ORDER BY t.updated_at LIMIT 1",
    a.email,
    ts,
  );
  if (mine) return c.json({ task: summary(mine), resume: true });
  const last = await first<{ last_task_type: string | null }>(c.env.DB, "SELECT last_task_type FROM activity WHERE email = ?", a.email);
  const assigned = a.role === "operator" ? "AND t.client_id IN (SELECT client_id FROM client_assignments WHERE user_email = ?)" : "AND ? IS NOT NULL";
  const next = await first<TaskRow & { client_name: string }>(
    c.env.DB,
    `SELECT t.*, c.name AS client_name FROM tasks t JOIN clients c ON c.id = t.client_id
     WHERE (t.status = 'queued' OR (t.status = 'in_review' AND (t.lock_holder IS NULL OR t.lock_expires_at <= ?))) ${assigned}
     ORDER BY CASE WHEN t.type = ? THEN 1 ELSE 0 END, t.queued_at, t.created_at LIMIT 1`,
    ts,
    a.email,
    last?.last_task_type ?? "",
  );
  const counts = await first<{ processing: number }>(c.env.DB, "SELECT COUNT(*) AS processing FROM tasks WHERE status = 'processing'");
  return c.json({ task: next ? summary(next) : null, resume: false, processing: counts?.processing ?? 0 });
});

app.get("/api/review/next", requireRole("senior", "admin"), async (c) => {
  const a = c.get("actor");
  const ts = nowIso(c.env);
  const next = await first<TaskRow & { client_name: string }>(
    c.env.DB,
    `SELECT t.*, c.name AS client_name FROM tasks t JOIN clients c ON c.id = t.client_id
     WHERE t.status = 'second_review' AND COALESCE(t.operator_approved_by, '') <> ? AND (t.needs_licensed_reviewer = 0 OR ? = 1)
       AND (t.lock_holder IS NULL OR t.lock_holder = ? OR t.lock_expires_at <= ?)
     ORDER BY t.operator_approved_at LIMIT 1`,
    a.email,
    a.licensed_apn ? 1 : 0,
    a.email,
    ts,
  );
  return c.json({ task: next ? summary(next) : null });
});

// Listing is for leads, admin and audit; operators only ever see the next item.
app.get("/api/tasks", requireRole("senior", "admin", "auditor"), async (c) => {
  const status = c.req.query("status");
  const rows = await all<TaskRow & { client_name: string }>(
    c.env.DB,
    `SELECT t.*, c.name AS client_name FROM tasks t JOIN clients c ON c.id = t.client_id ${status ? "WHERE t.status = ?" : "WHERE ? IS NULL"} ORDER BY t.created_at DESC LIMIT 200`,
    status ?? null,
  );
  return c.json(rows.map(summary));
});

async function loadTask(env: Env, actor: Actor, id: string): Promise<TaskRow> {
  const task = await getTask(env, id);
  if (!task || !(await canSeeClient(env, actor, task.client_id))) throw new HTTPException(404, { message: "Task not found" });
  return task;
}

app.get("/api/tasks/:id", async (c) => {
  const a = c.get("actor");
  const task = await loadTask(c.env, a, c.req.param("id"));
  await audit(c.env, a.email, task.id, "view", {});
  return c.json(await buildTaskView(c.env, task, a));
});

app.post("/api/tasks/:id/open", async (c) => {
  const a = c.get("actor");
  const task = await loadTask(c.env, a, c.req.param("id"));
  assertCanWork(task, a);
  await acquireLock(c.env, task, a);
  if (task.status === "queued") {
    await run(c.env.DB, "UPDATE tasks SET status = 'in_review', updated_at = ? WHERE id = ?", nowIso(c.env), task.id);
    task.status = "in_review";
  }
  await audit(c.env, a.email, task.id, "opened", {});
  await touchActivity(c.env, a, null);
  return c.json(await buildTaskView(c.env, task, a));
});

app.post("/api/tasks/:id/heartbeat", async (c) => {
  const a = c.get("actor");
  const task = await loadTask(c.env, a, c.req.param("id"));
  if (lockHeldByOther(c.env, task, a)) throw new HTTPException(409, { message: `Open by ${task.lock_holder}` });
  if (task.lock_holder === a.email) await acquireLock(c.env, task, a);
  return c.json({ lock_expires_at: task.lock_expires_at });
});

app.post("/api/tasks/:id/leave", async (c) => {
  const a = c.get("actor");
  const task = await loadTask(c.env, a, c.req.param("id"));
  if (task.lock_holder === a.email) await releaseLock(c.env, task.id);
  await audit(c.env, a.email, task.id, "left", {});
  return c.json({ ok: true });
});

const DecisionBody = z.object({
  id: z.string().min(8).max(64),
  claim_id: z.string(),
  action: DecisionAction,
  value: z.string().max(5000).nullish(),
  note: z.string().max(2000).nullish(),
  time_ms: z.number().int().min(0).max(24 * 3600 * 1000).nullish(),
});

app.post("/api/tasks/:id/decisions", async (c) => {
  const a = c.get("actor");
  const task = await loadTask(c.env, a, c.req.param("id"));
  const body = DecisionBody.parse(await c.req.json());
  const res = await decide(c.env, a, task, body);
  const fresh = (await getTask(c.env, task.id))!;
  return c.json({ ok: true, outcome: res.outcome, canary: res.canary, task: await buildTaskView(c.env, fresh, a) });
});

const EditBody = z.union([
  z.object({ kind: z.literal("field"), field: z.string(), value: z.string().nullable() }),
  z.object({ kind: z.literal("body"), body: z.string().max(50_000) }),
]);

app.put("/api/tasks/:id/draft", async (c) => {
  const a = c.get("actor");
  const task = await loadTask(c.env, a, c.req.param("id"));
  assertCanWork(task, a);
  await acquireLock(c.env, task, a);
  const body = EditBody.parse(await c.req.json());
  const claims = await getClaims(c.env, task.current_draft_id!);
  if (body.kind === "body" && claims.some(isRekeyPending)) throw new HTTPException(409, { message: "Re-key the hidden values before editing the text" });
  if (body.kind === "field" && claims.some((cl) => cl.field === body.field && isRekeyPending(cl))) throw new HTTPException(409, { message: "Re-key this value first" });
  const res = await applyEdit(c.env, a, task, body);
  await touchActivity(c.env, a, task.type);
  const fresh = (await getTask(c.env, task.id))!;
  return c.json({ ok: true, canary: res.canary, task: await buildTaskView(c.env, fresh, a) });
});

app.post("/api/tasks/:id/approve", async (c) => {
  const a = c.get("actor");
  const task = await loadTask(c.env, a, c.req.param("id"));
  const result = await approve(c.env, a, task);
  const fresh = (await getTask(c.env, task.id))!;
  return c.json({ result, task: await buildTaskView(c.env, fresh, a) });
});

app.post("/api/tasks/:id/reject", async (c) => {
  const a = c.get("actor");
  const task = await loadTask(c.env, a, c.req.param("id"));
  const body = z.object({ note: z.string().max(2000) }).parse(await c.req.json());
  await reject(c.env, a, task, body.note);
  return c.json({ ok: true });
});

app.get("/api/tasks/:id/audit", requireRole("senior", "admin", "auditor"), async (c) => {
  const task = await loadTask(c.env, c.get("actor"), c.req.param("id"));
  const events = await all<{ id: number; ts: string; actor: string; event: string; detail_json: string }>(c.env.DB, "SELECT * FROM audit_events WHERE task_id = ? ORDER BY id", task.id);
  return c.json(events.map((e) => ({ ...e, detail: parseJson(e.detail_json, {}) })));
});

// ---------- Releases, audit rebuild and incidents ----------

app.get("/api/releases/:id", async (c) => {
  const rel = await first<{ id: string; task_id: string; output_json: string; output_hash: string; destination: string; approved_by: string; second_reviewer: string | null; created_at: string }>(
    c.env.DB,
    "SELECT * FROM releases WHERE id = ?",
    c.req.param("id"),
  );
  if (!rel) throw new HTTPException(404, { message: "Not found" });
  await loadTask(c.env, c.get("actor"), rel.task_id);
  return c.json({ ...rel, output: JSON.parse(rel.output_json) });
});

/** Rebuild, for a release, who confirmed each claim against which source span and when. */
export async function auditReport(env: Env, releaseId: string) {
  const rel = await first<{ id: string; task_id: string; draft_id: string; approved_by: string; second_reviewer: string | null; created_at: string; output_hash: string }>(
    env.DB,
    "SELECT * FROM releases WHERE id = ?",
    releaseId,
  );
  if (!rel) throw new HTTPException(404, { message: "Not found" });
  const source = (await getSource(env, rel.task_id))!;
  const pages = parseJson<{ index: number; start: number; end: number }[]>(source.layout_json, []);
  const allClaims = await all<ClaimRow>(env.DB, "SELECT * FROM claims WHERE task_id = ?", rel.task_id);
  const byId = new Map(allClaims.map((c) => [c.id, c]));
  const decisions = await all<{ id: string; claim_id: string; actor: string; role: string; action: string; value: string | null; note: string | null; outcome: string | null; time_ms: number | null; created_at: string }>(
    env.DB,
    "SELECT * FROM decisions WHERE task_id = ? ORDER BY created_at, rowid",
    rel.task_id,
  );
  const claims = allClaims.filter((c) => c.draft_id === rel.draft_id).sort((x, y) => x.ord - y.ord);
  return {
    release: rel,
    claims: claims.map((c) => {
      const chain: string[] = [];
      for (let cur: ClaimRow | undefined = c; cur; cur = cur.prev_claim_id ? byId.get(cur.prev_claim_id) : undefined) chain.push(cur.id);
      const span = c.source_start != null ? { start: c.source_start, end: c.source_end!, page: (pages.find((p) => c.source_start! >= p.start && c.source_start! <= p.end)?.index ?? 0) + 1, text: source.text.slice(c.source_start, c.source_end!) } : null;
      return {
        label: c.label,
        type: c.type,
        field: c.field,
        value: c.value_true,
        status: c.status,
        source_span: span,
        checks: parseJson(c.checks_json, []),
        decisions: decisions.filter((d) => chain.includes(d.claim_id)),
      };
    }),
  };
}

app.get("/api/releases/:id/audit-report", requireRole("senior", "admin", "auditor"), async (c) => c.json(await auditReport(c.env, c.req.param("id"))));

app.post("/api/releases/:id/incidents", requireRole("senior", "admin", "auditor"), async (c) => {
  const body = z.object({ report: z.string().min(1).max(5000), claim_ids: z.array(z.string()).default([]) }).parse(await c.req.json());
  const rel = await first<{ id: string; task_id: string }>(c.env.DB, "SELECT id, task_id FROM releases WHERE id = ?", c.req.param("id"));
  if (!rel) throw new HTTPException(404, { message: "Not found" });
  const id = newId("in");
  await run(c.env.DB, "INSERT INTO incidents (id, release_id, task_id, reported_by, report, claim_ids_json, created_at) VALUES (?,?,?,?,?,?,?)", id, rel.id, rel.task_id, c.get("actor").email, body.report, JSON.stringify(body.claim_ids), nowIso(c.env));
  await audit(c.env, c.get("actor").email, rel.task_id, "incident_logged", { incident_id: id });
  return c.json({ id }, 201);
});

app.patch("/api/incidents/:id", requireRole("senior", "admin"), async (c) => {
  const body = z.object({ root_cause: z.enum(["source", "extraction", "drafting", "check", "operator"]).optional(), fix: z.string().max(5000).optional(), status: z.enum(["open", "closed"]).optional() }).parse(await c.req.json());
  const inc = await first<{ id: string; task_id: string }>(c.env.DB, "SELECT id, task_id FROM incidents WHERE id = ?", c.req.param("id"));
  if (!inc) throw new HTTPException(404, { message: "Not found" });
  await run(
    c.env.DB,
    "UPDATE incidents SET root_cause = COALESCE(?, root_cause), fix = COALESCE(?, fix), status = COALESCE(?, status), closed_at = CASE WHEN ? = 'closed' THEN ? ELSE closed_at END WHERE id = ?",
    body.root_cause,
    body.fix,
    body.status,
    body.status,
    nowIso(c.env),
    inc.id,
  );
  await audit(c.env, c.get("actor").email, inc.task_id, "incident_updated", body);
  return c.json({ ok: true });
});

app.get("/api/incidents", requireRole("senior", "admin", "auditor"), async (c) => c.json(await all(c.env.DB, "SELECT * FROM incidents ORDER BY created_at DESC")));

app.get("/api/spot-checks", requireRole("senior", "admin"), async (c) => c.json(await all(c.env.DB, "SELECT * FROM spot_checks WHERE reviewed_at IS NULL ORDER BY created_at")));

// ---------- Metrics ----------

function quantiles(xs: number[]) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: q(0.5), p25: q(0.25), p75: q(0.75) };
}

app.get("/api/metrics", requireRole("senior", "admin", "auditor"), async (c) => {
  const db = c.env.DB;
  const draftError = await all(
    db,
    `SELECT t.client_id, t.type, SUM(CASE WHEN cl.status = 'corrected' THEN 1 ELSE 0 END) AS corrected, COUNT(*) AS checked
     FROM releases r JOIN tasks t ON t.id = r.task_id JOIN claims cl ON cl.draft_id = r.draft_id GROUP BY t.client_id, t.type`,
  );
  const catchRate = await all(
    db,
    `SELECT operator, strftime('%Y-W%W', resolved_at) AS week, SUM(outcome = 'caught') AS caught, SUM(outcome = 'missed') AS missed
     FROM canaries WHERE outcome IN ('caught','missed') GROUP BY operator, week ORDER BY week DESC, operator`,
  );
  const escaped = await first(db, "SELECT COUNT(*) AS escaped, SUM(status = 'open') AS open FROM incidents");
  const perClaimRows = await all<{ tier: number; type: string; time_ms: number }>(db, "SELECT t.tier, t.type, d.time_ms FROM decisions d JOIN tasks t ON t.id = d.task_id WHERE d.time_ms IS NOT NULL");
  const perItemRows = await all<{ tier: number; type: string; total: number }>(
    db,
    "SELECT t.tier, t.type, SUM(d.time_ms) AS total FROM decisions d JOIN tasks t ON t.id = d.task_id JOIN releases r ON r.task_id = t.id WHERE d.time_ms IS NOT NULL GROUP BY t.id",
  );
  const groupBy = <T extends { tier: number; type: string }>(rows: T[], val: (r: T) => number) => {
    const m = new Map<string, number[]>();
    for (const r of rows) m.set(`${r.type} · tier ${r.tier}`, [...(m.get(`${r.type} · tier ${r.tier}`) ?? []), val(r)]);
    return [...m.entries()].map(([k, xs]) => ({ group: k, ...quantiles(xs) }));
  };
  const flags = await all(db, "SELECT note, COUNT(*) AS n FROM decisions WHERE action = 'flag' GROUP BY note ORDER BY n DESC LIMIT 50");
  const findings = await first(
    db,
    `SELECT COUNT(DISTINCT r.id) AS drafts, SUM(cl.group_name = 'unsupported') AS unsupported, SUM(cl.group_name = 'omitted') AS omitted
     FROM releases r JOIN claims cl ON cl.draft_id = r.draft_id`,
  );
  return c.json({
    draft_error_rate: draftError,
    seeded_catch_rate: catchRate,
    escaped_errors: escaped,
    time_per_claim_ms: groupBy(perClaimRows, (r) => r.time_ms),
    time_per_item_ms: groupBy(perItemRows, (r) => r.total),
    flags_and_escalations: flags,
    unsupported_and_omitted: findings,
  });
});

// ---------- Admin ----------

app.get("/api/admin/clients", requireRole("admin", "auditor"), async (c) => {
  const rows = await all<{ id: string; flags_json: string }>(c.env.DB, "SELECT * FROM clients ORDER BY name");
  return c.json(rows.map((r) => ({ ...r, flags: resolveFlags(r.flags_json), phase_gated: PHASE_GATED })));
});

app.patch("/api/admin/clients/:id", requireRole("admin"), async (c) => {
  const body = z
    .object({
      tier3_threshold_cents: z.number().int().positive().optional(),
      seeded_rate: z.number().int().min(0).max(1000).optional(),
      retention_days: z.number().int().min(1).max(3650).optional(),
      spot_check_floor_ms: z.number().int().min(0).nullable().optional(),
      flags: z.record(z.string(), z.boolean()).optional(),
    })
    .parse(await c.req.json());
  const client = await getClient(c.env, c.req.param("id"));
  if (!client) throw new HTTPException(404, { message: "Not found" });
  const flags = { ...resolveFlags(client.flags_json) };
  for (const [k, v] of Object.entries(body.flags ?? {})) {
    if (!(k in FLAG_DEFAULTS)) throw new HTTPException(400, { message: `Unknown flag ${k}` });
    if (v && PHASE_GATED[k as FlagName]) throw new HTTPException(409, { message: `${k} waits on: ${PHASE_GATED[k as FlagName]}` });
    flags[k as FlagName] = v;
  }
  await run(
    c.env.DB,
    "UPDATE clients SET tier3_threshold_cents = COALESCE(?, tier3_threshold_cents), seeded_rate = COALESCE(?, seeded_rate), retention_days = COALESCE(?, retention_days), spot_check_floor_ms = CASE WHEN ? THEN ? ELSE spot_check_floor_ms END, flags_json = ? WHERE id = ?",
    body.tier3_threshold_cents,
    body.seeded_rate,
    body.retention_days,
    body.spot_check_floor_ms !== undefined ? 1 : 0,
    body.spot_check_floor_ms ?? null,
    JSON.stringify(flags),
    client.id,
  );
  await audit(c.env, c.get("actor").email, null, "client_settings_changed", { client_id: client.id, ...body });
  return c.json({ ok: true });
});

app.get("/api/admin/playbooks/:clientId", requireRole("admin", "auditor"), async (c) =>
  c.json(await all(c.env.DB, "SELECT id, task_type, version, active, created_by, created_at, content_json FROM playbooks WHERE client_id = ? ORDER BY task_type, version DESC", c.req.param("clientId"))),
);

app.post("/api/admin/playbooks/:clientId", requireRole("admin"), async (c) => {
  const body = z.object({ task_type: z.enum(["supplier_bill", "tenant_email"]), content: Playbook }).parse(await c.req.json());
  const clientId = c.req.param("clientId");
  const cur = await first<{ v: number | null }>(c.env.DB, "SELECT MAX(version) AS v FROM playbooks WHERE client_id = ? AND task_type = ?", clientId, body.task_type);
  const version = (cur?.v ?? 0) + 1;
  const id = `pb_${clientId}_${body.task_type}_${version}`;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE playbooks SET active = 0 WHERE client_id = ? AND task_type = ?").bind(clientId, body.task_type),
    c.env.DB.prepare("INSERT INTO playbooks (id, client_id, task_type, version, content_json, created_by, created_at, active) VALUES (?,?,?,?,?,?,?,1)").bind(id, clientId, body.task_type, version, JSON.stringify(body.content), c.get("actor").email, nowIso(c.env)),
  ]);
  await audit(c.env, c.get("actor").email, null, "playbook_published", { id, version });
  return c.json({ id, version }, 201);
});

app.get("/api/admin/users", requireRole("admin", "auditor"), async (c) =>
  c.json(await all(c.env.DB, "SELECT u.*, (SELECT GROUP_CONCAT(client_id) FROM client_assignments ca WHERE ca.user_email = u.email) AS clients FROM users u ORDER BY role, email")),
);

app.post("/api/admin/users", requireRole("admin"), async (c) => {
  const body = z
    .object({ email: z.string().email(), name: z.string().min(1), role: z.enum(["operator", "senior", "admin", "auditor"]), licensed_apn: z.boolean().default(false), clients: z.array(z.string()).default([]), active: z.boolean().default(true) })
    .parse(await c.req.json());
  const domain = c.env.ALLOWED_EMAIL_DOMAIN ?? "mesquaredagency.com";
  if (!body.email.toLowerCase().endsWith(`@${domain}`)) throw new HTTPException(400, { message: `Only @${domain} accounts` });
  const email = body.email.toLowerCase();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO users (email, name, role, licensed_apn, active) VALUES (?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name = excluded.name, role = excluded.role, licensed_apn = excluded.licensed_apn, active = excluded.active").bind(email, body.name, body.role, body.licensed_apn ? 1 : 0, body.active ? 1 : 0),
    c.env.DB.prepare("DELETE FROM client_assignments WHERE user_email = ?").bind(email),
    ...body.clients.map((cl) => c.env.DB.prepare("INSERT INTO client_assignments (client_id, user_email) VALUES (?, ?)").bind(cl, email)),
  ]);
  await audit(c.env, c.get("actor").email, null, "user_saved", { email, role: body.role, clients: body.clients });
  return c.json({ ok: true });
});

app.get("/api/meta", (c) => c.json({ claim_group_order: CLAIM_GROUP_ORDER }));

export type { Actor };
