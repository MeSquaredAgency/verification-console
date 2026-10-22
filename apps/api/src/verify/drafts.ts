// Draft versions, claims persistence and seeded test errors.
// The true draft is always stored separately from any seeded copy; release builds only from
// the true draft, so a seeded value can never leave.
import { addDays, formatDate, parseDate, type DraftContent } from "@vc/shared";
import { nowIso } from "../lib/clock";
import { newId, stmt } from "../lib/db";
import type { Env } from "../lib/env";
import type { BuiltClaim } from "../pipeline/claims";

export type Carry = { status: string; rekeyed: number; rekey_mismatch: number; prev_claim_id: string };

export type CanarySeed = { key: string; seeded: string };

/** Map a position in the true reply body to the displayed (seeded) body. */
export function toDisplay(pos: number, canary: { ts: number; te: number; delta: number } | null): number {
  if (!canary || pos <= canary.ts) return pos;
  if (pos >= canary.te) return pos + canary.delta;
  return canary.ts;
}

export function applySeed(content: DraftContent, claim: BuiltClaim, seeded: string): DraftContent {
  if (content.kind === "bill") return { kind: "bill", bill: { ...content.bill, [claim.field!]: seeded } };
  const b = content.reply.body;
  return { kind: "reply", reply: { ...content.reply, body: b.slice(0, claim.true_start!) + seeded + b.slice(claim.true_end!) } };
}

export async function saveDraftVersion(
  env: Env,
  p: {
    taskId: string;
    version: number;
    content: DraftContent;
    author: string;
    model: string | null;
    promptVersion: string | null;
    parentId: string | null;
    claims: BuiltClaim[];
    carry?: Map<string, Carry>;
    canary?: CanarySeed | null;
    /** An existing pending canary (by claim key) to keep on the new version. */
    keepCanary?: { id: string; key: string; seeded: string } | null;
  },
): Promise<{ draftId: string; claimIds: Map<string, string> }> {
  const draftId = newId("dr");
  const ts = nowIso(env);
  const seed = p.canary ?? (p.keepCanary ? { key: p.keepCanary.key, seeded: p.keepCanary.seeded } : null);
  const seededClaim = seed ? p.claims.find((c) => c.key === seed.key) : undefined;
  const display = seededClaim ? applySeed(p.content, seededClaim, seed!.seeded) : null;
  const shift =
    seededClaim && p.content.kind === "reply"
      ? { ts: seededClaim.true_start!, te: seededClaim.true_end!, delta: seed!.seeded.length - (seededClaim.true_end! - seededClaim.true_start!) }
      : null;

  const stmts: D1PreparedStatement[] = [
    stmt(
      env.DB,
      "INSERT INTO drafts (id, task_id, version, content_json, display_json, author, model, prompt_version, parent_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
      draftId,
      p.taskId,
      p.version,
      JSON.stringify(p.content),
      display ? JSON.stringify(display) : null,
      p.author,
      p.model,
      p.promptVersion,
      p.parentId,
      ts,
    ),
  ];
  const claimIds = new Map<string, string>();
  p.claims.forEach((c, i) => {
    const id = newId("cl");
    claimIds.set(c.key, id);
    const carried = p.carry?.get(c.key);
    const isSeed = seededClaim?.key === c.key;
    const dStart = c.true_start == null ? null : isSeed ? shift!.ts : toDisplay(c.true_start, shift);
    const dEnd = c.true_end == null ? null : isSeed ? shift!.ts + seed!.seeded.length : toDisplay(c.true_end, shift);
    stmts.push(
      stmt(
        env.DB,
        `INSERT INTO claims (id, task_id, draft_id, ord, claim_key, type, label, field, value_true, value_display, start, end, true_start, true_end,
          source_value, source_start, source_end, checks_json, model_verdict, group_name, needs_rekey, rekeyed, rekey_mismatch, status,
          prev_claim_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        id,
        p.taskId,
        draftId,
        i,
        c.key,
        c.type,
        c.label,
        c.field,
        c.value,
        isSeed ? seed!.seeded : c.value,
        dStart,
        dEnd,
        c.true_start,
        c.true_end,
        c.source_value,
        c.source_span?.start ?? null,
        c.source_span?.end ?? null,
        JSON.stringify(c.checks),
        c.model_verdict,
        c.group,
        c.needs_rekey ? 1 : 0,
        carried?.rekeyed ?? 0,
        carried?.rekey_mismatch ?? 0,
        carried?.status ?? "undecided",
        carried?.prev_claim_id ?? null,
        ts,
        ts,
      ),
    );
  });
  stmts.push(stmt(env.DB, "UPDATE tasks SET current_draft_id = ?, updated_at = ? WHERE id = ?", draftId, ts, p.taskId));
  if (p.canary && seededClaim) {
    stmts.push(
      stmt(
        env.DB,
        "INSERT INTO canaries (id, task_id, draft_id, claim_id, label, original_value, seeded_value, outcome, created_at) VALUES (?,?,?,?,?,?,?, 'pending', ?)",
        newId("cn"),
        p.taskId,
        draftId,
        claimIds.get(seededClaim.key)!,
        seededClaim.label,
        seededClaim.value,
        p.canary.seeded,
        ts,
      ),
    );
  } else if (p.keepCanary && seededClaim) {
    stmts.push(stmt(env.DB, "UPDATE canaries SET draft_id = ?, claim_id = ? WHERE id = ?", draftId, claimIds.get(seededClaim.key)!, p.keepCanary.id));
  }
  await env.DB.batch(stmts);
  return { draftId, claimIds };
}

// ---------- Choosing and altering a seeded value ----------

/** Small deterministic PRNG so seeded choices are reproducible in tests. */
export function rng(seedText: string): () => number {
  let h = 2166136261;
  for (const ch of seedText) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

export function shouldSeed(env: Env, rate: number, enabled: boolean, rand: () => number): boolean {
  if (!enabled || env.SEED_MODE === "never") return false;
  if (env.SEED_MODE === "always") return true;
  return rate > 0 && rand() < 1 / rate;
}

function alterDigit(s: string, rand: () => number, onlyBeforeDot = false): string | null {
  const idx: number[] = [];
  const limit = onlyBeforeDot && s.includes(".") ? s.indexOf(".") : s.length;
  for (let i = 0; i < limit; i++) if (/\d/.test(s[i])) idx.push(i);
  if (!idx.length) return null;
  const i = idx[Math.floor(rand() * idx.length)];
  const d = Number(s[i]);
  let nd = (d + 1 + Math.floor(rand() * 8)) % 10;
  if (nd === d) nd = (d + 1) % 10;
  if (nd === 0 && i === idx[0]) nd = d === 9 ? 8 : d + 1; // no leading zero
  return s.slice(0, i) + nd + s.slice(i + 1);
}

function alterName(s: string, rand: () => number): string | null {
  const vowels = "aeiou";
  const idx: number[] = [];
  for (let i = 1; i < s.length - 1; i++) if (vowels.includes(s[i])) idx.push(i);
  if (!idx.length) return null;
  const i = idx[Math.floor(rand() * idx.length)];
  const options = vowels.replace(s[i], "");
  return s.slice(0, i) + options[Math.floor(rand() * options.length)] + s.slice(i + 1);
}

export function alterValue(c: BuiltClaim, rand: () => number): string | null {
  switch (c.type) {
    case "amount":
      return alterDigit(c.value, rand, true);
    case "date": {
      const p = parseDate(c.value);
      if (!p) return alterDigit(c.value, rand);
      const shifted = addDays(p.iso, [1, 2, 3, -1, -2][Math.floor(rand() * 5)]);
      return /^\d{4}-\d{2}-\d{2}$/.test(c.value) ? shifted : formatDate(shifted);
    }
    case "name":
      return alterName(c.value, rand);
    case "reference":
    case "number":
    case "abn":
      return alterDigit(c.value, rand);
    default:
      return null;
  }
}

/** Pick one claim to seed. Prefer claims in the Matched group: that is where attention slips. */
export function pickCanary(claims: BuiltClaim[], rand: () => number): CanarySeed | null {
  const eligible = claims.filter((c) => ["amount", "date", "name", "reference", "number", "abn"].includes(c.type) && c.field !== "to");
  const matched = eligible.filter((c) => c.group === "matched");
  const pool = matched.length ? matched : eligible;
  for (let tries = 0; tries < pool.length * 2 && pool.length; tries++) {
    const c = pool[Math.floor(rand() * pool.length)];
    const seeded = alterValue(c, rand);
    if (seeded && seeded !== c.value) return { key: c.key, seeded };
  }
  return null;
}
