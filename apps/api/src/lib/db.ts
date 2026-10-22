// Thin helpers over D1. D1 rejects `undefined` bindings, so they become NULL.

const clean = (args: unknown[]) => args.map((a) => (a === undefined ? null : a));

export async function all<T = Record<string, unknown>>(db: D1Database, sql: string, ...args: unknown[]): Promise<T[]> {
  const res = await db.prepare(sql).bind(...clean(args)).all<T>();
  return res.results ?? [];
}

export async function first<T = Record<string, unknown>>(db: D1Database, sql: string, ...args: unknown[]): Promise<T | null> {
  return (await db.prepare(sql).bind(...clean(args)).first<T>()) ?? null;
}

export async function run(db: D1Database, sql: string, ...args: unknown[]): Promise<D1Result> {
  return db.prepare(sql).bind(...clean(args)).run();
}

export function stmt(db: D1Database, sql: string, ...args: unknown[]): D1PreparedStatement {
  return db.prepare(sql).bind(...clean(args));
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (s == null || s === "") return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
