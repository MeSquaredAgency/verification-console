// Demo data: users, the fictional APN-style client, playbooks and reference records.
import { DEMO_CLIENT, DEMO_PLAYBOOK, DEMO_REFERENCE, DEMO_USERS } from "../../../fixtures/data";
import { nowIso } from "./lib/clock";
import { stmt } from "./lib/db";
import type { Env } from "./lib/env";

/** Idempotent: rows that already exist (e.g. from migration 0002) are left alone. */
export async function seedDemo(env: Env): Promise<{ seeded: boolean }> {
  const ts = nowIso(env);
  const c = DEMO_CLIENT;
  const s: D1PreparedStatement[] = [
    stmt(env.DB, "INSERT OR IGNORE INTO clients (id, name, tier3_threshold_cents, seeded_rate, retention_days, flags_json) VALUES (?,?,?,?,?,?)", c.id, c.name, c.tier3_threshold_cents, c.seeded_rate, c.retention_days, "{}"),
  ];
  for (const u of DEMO_USERS) {
    s.push(stmt(env.DB, "INSERT OR IGNORE INTO users (email, name, role, licensed_apn) VALUES (?,?,?,?)", u.email, u.name, u.role, u.licensed_apn));
    if (u.role === "operator") s.push(stmt(env.DB, "INSERT OR IGNORE INTO client_assignments (client_id, user_email) VALUES (?, ?)", c.id, u.email));
  }
  for (const type of ["supplier_bill", "tenant_email"]) {
    s.push(stmt(env.DB, "INSERT OR IGNORE INTO playbooks (id, client_id, task_type, version, content_json, created_by, created_at) VALUES (?,?,?,?,?,?,?)", `pb_${c.id}_${type}_1`, c.id, type, 1, JSON.stringify(DEMO_PLAYBOOK), "seed", ts));
  }
  const ref = DEMO_REFERENCE;
  const rows: [string, string, unknown][] = [
    ...ref.suppliers.map((x) => ["supplier", x.name, x] as [string, string, unknown]),
    ...ref.tenancies.map((x) => ["tenancy", x.tenant_name, x] as [string, string, unknown]),
    ...ref.contacts.map((x) => ["contact", x.email, x] as [string, string, unknown]),
    ...ref.account_codes.map((x) => ["account_code", x.code, x] as [string, string, unknown]),
  ];
  rows.forEach(([kind, key, data], i) => {
    s.push(stmt(env.DB, "INSERT OR IGNORE INTO reference_records (id, client_id, kind, key, data_json, updated_at) VALUES (?,?,?,?,?,?)", `ref_${i}`, c.id, kind, key, JSON.stringify(data), ts));
  });
  await env.DB.batch(s);
  return { seeded: true };
}
