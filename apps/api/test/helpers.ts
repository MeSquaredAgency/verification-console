// Test doubles for the Cloudflare bindings: D1 on Node's built-in SQLite, R2 in memory and a
// queue that is drained synchronously through the real consumer.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import type { TaskView } from "@vc/shared";
import { app } from "../src/app";
import type { Env, PipelineMessage } from "../src/lib/env";
import { handleBatch } from "../src/pipeline/run";
import { seedDemo } from "../src/seed";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, "../../../fixtures");

class Stmt {
  constructor(
    private db: DatabaseSync,
    private sql: string,
    private args: unknown[] = [],
  ) {}
  bind(...args: unknown[]) {
    return new Stmt(this.db, this.sql, args);
  }
  private params() {
    return this.args.map((a) => (a === undefined ? null : a)) as SQLInputValue[];
  }
  async all<T>() {
    return { results: this.db.prepare(this.sql).all(...this.params()) as T[], success: true, meta: {} };
  }
  async first<T>() {
    return (this.db.prepare(this.sql).get(...this.params()) as T | undefined) ?? null;
  }
  async run() {
    return this.runSync();
  }
  runSync() {
    const r = this.db.prepare(this.sql).run(...this.params());
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export function d1(): D1Database & { raw: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(path.resolve(here, "../migrations")).sort()) db.exec(readFileSync(path.resolve(here, "../migrations", f), "utf8"));
  return {
    raw: db,
    prepare: (sql: string) => new Stmt(db, sql),
    batch: async (stmts: Stmt[]) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.runSync());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as D1Database & { raw: DatabaseSync };
}

function r2(): R2Bucket {
  const m = new Map<string, Uint8Array>();
  return {
    put: async (k: string, v: Uint8Array) => {
      m.set(k, new Uint8Array(v));
      return {} as R2Object;
    },
    get: async (k: string) => (m.has(k) ? ({ body: new Blob([m.get(k)! as Uint8Array<ArrayBuffer>]).stream(), arrayBuffer: async () => m.get(k)!.buffer } as unknown as R2ObjectBody) : null),
    delete: async (k: string) => {
      m.delete(k);
    },
    _map: m,
  } as unknown as R2Bucket;
}

export type TestEnv = Env & { queue: PipelineMessage[]; DB: D1Database & { raw: DatabaseSync } };

export async function makeEnv(overrides: Partial<Env> = {}): Promise<TestEnv> {
  const queue: PipelineMessage[] = [];
  const env = {
    DB: d1(),
    FILES: r2(),
    PIPELINE: { send: async (m: PipelineMessage) => void queue.push(m), sendBatch: async () => {} } as unknown as Queue<PipelineMessage>,
    DEV_AUTH: "1",
    MODEL_MODE: "offline",
    CLOCK_NOW: "2026-10-22T01:00:00.000Z",
    SEED_MODE: "never",
    FILE_URL_SECRET: "test",
    queue,
    ...overrides,
  } as TestEnv;
  await seedDemo(env);
  return env;
}

/** Run queued pipeline messages through the real consumer until the queue is empty. */
export async function drain(env: TestEnv) {
  let guard = 0;
  while (env.queue.length) {
    if (guard++ > 500) throw new Error("queue did not drain");
    const body = env.queue.shift()!;
    let attempts = 1;
    for (;;) {
      let retried = false;
      const msg = { body, attempts, id: "m", timestamp: new Date(), ack: () => {}, retry: () => (retried = true) };
      await handleBatch({ messages: [msg], queue: "vc-pipeline", ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<PipelineMessage>, env);
      if (!retried) break;
      attempts++;
    }
  }
}

export const OP = "sophea@mesquaredagency.com";
export const OP2 = "dara@mesquaredagency.com";
export const LEAD = "lead@mesquaredagency.com";
export const LICENSED = "licensed@mesquaredagency.com";
export const ADMIN = "elliot.crabb@mesquaredagency.com";
export const AUDITOR = "patrick@mesquaredagency.com";

export async function api<T = any>(env: TestEnv, method: string, url: string, user: string | null, body?: unknown): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = {};
  if (user) headers["X-Dev-User"] = user;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await app.request(url, { method, headers, body: payload }, env);
  const text = await res.text();
  let json: T;
  try {
    json = JSON.parse(text);
  } catch {
    json = text as T;
  }
  return { status: res.status, json };
}

export function fixturePdf(id: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURES, "bills", `${id}.pdf`)));
}

export function fixtureEmail(id: string): string {
  return readFileSync(path.join(FIXTURES, "emails", `${id}.txt`), "utf8");
}

/** Submit a fixture and run the pipeline to completion. */
export async function ingest(env: TestEnv, id: string, user = OP): Promise<string> {
  let res;
  if (id.startsWith("B")) {
    const form = new FormData();
    form.set("client_id", "apn-demo");
    form.set("file", new File([fixturePdf(id) as Uint8Array<ArrayBuffer>], `${id}.pdf`, { type: "application/pdf" }));
    res = await api(env, "POST", "/api/tasks", user, form);
  } else {
    res = await api(env, "POST", "/api/tasks", user, { client_id: "apn-demo", email: fixtureEmail(id) });
  }
  if (res.status !== 201) throw new Error(`intake failed: ${res.status} ${JSON.stringify(res.json)}`);
  await drain(env);
  return res.json.id;
}

export async function open(env: TestEnv, id: string, user = OP): Promise<TaskView> {
  const r = await api<TaskView>(env, "POST", `/api/tasks/${id}/open`, user);
  if (r.status !== 200) throw new Error(`open failed: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
}

let decisionCounter = 0;
export function did() {
  return `dec_${Date.now()}_${++decisionCounter}`;
}

export function rows<T = any>(env: TestEnv, sql: string, ...args: SQLInputValue[]): T[] {
  return env.DB.raw.prepare(sql).all(...args) as T[];
}

/**
 * Decide every open claim the way a careful operator would, reading true values from the DB
 * (standing in for the operator reading the source). Returns the final view.
 */
export async function decideAll(env: TestEnv, taskId: string, user = OP, opts: { trustDisplay?: boolean } = {}): Promise<TaskView> {
  let view = (await api<TaskView>(env, "GET", `/api/tasks/${taskId}`, user)).json;
  for (let guard = 0; guard < 200; guard++) {
    const c = view.claims.find((x) => x.status === "undecided");
    if (!c) return view;
    const row = rows<{ value_true: string; value_display: string }>(env, "SELECT value_true, value_display FROM claims WHERE id = ?", c.id)[0];
    const truth = opts.trustDisplay ? row.value_display : row.value_true;
    let body: Record<string, unknown>;
    if (c.rekey_pending) body = { action: "rekey", value: truth };
    else if (c.rekey_mismatch) body = { action: "correct", value: truth };
    else if (c.group === "unsupported" || c.group === "omitted") body = { action: "confirm", note: "Checked: OK to leave as is" };
    else body = { action: "confirm" };
    const r = await api(env, "POST", `/api/tasks/${taskId}/decisions`, user, { id: did(), claim_id: c.id, time_ms: 1200, ...body });
    if (r.status !== 200) throw new Error(`decision failed on ${c.label}: ${r.status} ${JSON.stringify(r.json)}`);
    view = r.json.task;
  }
  throw new Error("decideAll did not converge");
}
