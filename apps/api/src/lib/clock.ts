import type { Env } from "./env";

export function now(env: Env): Date {
  return env.CLOCK_NOW ? new Date(env.CLOCK_NOW) : new Date();
}

export function nowIso(env: Env): string {
  return now(env).toISOString();
}

/** Today's date in Sydney, YYYY-MM-DD (all clients are in NSW for the pilot). */
export function todayIso(env: Env): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Sydney" }).format(now(env));
}
