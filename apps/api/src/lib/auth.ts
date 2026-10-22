// Sign-in is Cloudflare Access with Google Workspace. Access puts a signed JWT in
// Cf-Access-Jwt-Assertion; we verify it here (defence in depth) and look the user up in D1,
// which holds roles. Local development can use an X-Dev-User header when DEV_AUTH=1.
import type { MiddlewareHandler } from "hono";
import { first } from "./db";
import type { Actor, AppEnv, Env } from "./env";
import { HTTPException } from "hono/http-exception";

type Jwk = JsonWebKey & { kid: string };
let certCache: { domain: string; keys: Jwk[]; at: number } | null = null;

function b64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function accessKeys(domain: string): Promise<Jwk[]> {
  if (certCache && certCache.domain === domain && Date.now() - certCache.at < 3600_000) return certCache.keys;
  const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new HTTPException(503, { message: "Cannot fetch Access certs" });
  const body = (await res.json()) as { keys: Jwk[] };
  certCache = { domain, keys: body.keys, at: Date.now() };
  return body.keys;
}

export async function verifyAccessJwt(token: string, env: Env): Promise<string> {
  const [h, p, sig] = token.split(".");
  if (!h || !p || !sig) throw new HTTPException(401, { message: "Malformed Access token" });
  const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { kid: string; alg: string };
  const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as { aud: string | string[]; exp: number; email?: string; iss?: string };
  const jwk = (await accessKeys(env.ACCESS_TEAM_DOMAIN!)).find((k) => k.kid === header.kid);
  if (!jwk || header.alg !== "RS256") throw new HTTPException(401, { message: "Unknown signing key" });
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(sig) as Uint8Array<ArrayBuffer>, new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new HTTPException(401, { message: "Bad Access token signature" });
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(env.ACCESS_AUD!)) throw new HTTPException(401, { message: "Wrong Access audience" });
  if (payload.exp * 1000 < Date.now()) throw new HTTPException(401, { message: "Access token expired" });
  if (!payload.email) throw new HTTPException(401, { message: "No email in Access token" });
  return payload.email.toLowerCase();
}

export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const env = c.env;
  let email: string | null = null;
  const jwt = c.req.header("Cf-Access-Jwt-Assertion");
  if (jwt && env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
    email = await verifyAccessJwt(jwt, env);
  } else if (env.DEV_AUTH === "1") {
    email = (c.req.header("X-Dev-User") ?? c.req.query("dev_user") ?? "").toLowerCase() || null;
  }
  if (!email) throw new HTTPException(401, { message: "Not signed in" });
  const domain = env.ALLOWED_EMAIL_DOMAIN ?? "mesquaredagency.com";
  if (!email.endsWith(`@${domain}`)) throw new HTTPException(403, { message: `Only @${domain} accounts` });
  const row = await first<{ email: string; name: string; role: Actor["role"]; licensed_apn: number; active: number }>(
    env.DB,
    "SELECT * FROM users WHERE email = ?",
    email,
  );
  if (!row || !row.active) throw new HTTPException(403, { message: "No console access for this account" });
  c.set("actor", { email: row.email, name: row.name, role: row.role, licensed_apn: !!row.licensed_apn });
  await next();
};

export function requireRole(...roles: Actor["role"][]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!roles.includes(c.get("actor").role)) throw new HTTPException(403, { message: "Not allowed for your role" });
    await next();
  };
}

/** Operators see only clients they're assigned to; seniors, admins and auditors see all. */
export async function canSeeClient(env: Env, actor: Actor, clientId: string): Promise<boolean> {
  if (actor.role !== "operator") return true;
  return !!(await first(env.DB, "SELECT 1 AS ok FROM client_assignments WHERE client_id = ? AND user_email = ?", clientId, actor.email));
}

/** Short-lived signed URLs for source files in the private R2 bucket. */
export async function signFileUrl(env: Env, key: string, ttlSeconds = 300, nowMs = Date.now()): Promise<string> {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const sig = await hmac(env, `${key}:${exp}`);
  return `/api/files/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
}

export async function verifyFileSig(env: Env, key: string, exp: string, sig: string, nowMs = Date.now()): Promise<boolean> {
  if (Number(exp) * 1000 < nowMs) return false;
  return (await hmac(env, `${key}:${exp}`)) === sig;
}

async function hmac(env: Env, msg: string): Promise<string> {
  const secret = env.FILE_URL_SECRET ?? "dev-only-file-url-secret";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(msg));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
