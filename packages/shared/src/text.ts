import { DATE_PATTERNS } from "./dates";

export type Span = { start: number; end: number };

/**
 * Find a verbatim quote in the source. Whitespace differences (line breaks inside a PDF,
 * double spaces) are tolerated; nothing else is. Returns null if the quote is not there.
 */
export function locateQuote(source: string, quote: string, from = 0): Span | null {
  const q = quote.trim();
  if (!q) return null;
  const exact = source.indexOf(q, from);
  if (exact >= 0) return { start: exact, end: exact + q.length };
  const parts = q.split(/\s+/).map(escapeRegExp);
  const re = new RegExp(parts.join("\\s+"), "g");
  re.lastIndex = from;
  const m = re.exec(source);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Start offsets of every occurrence of `needle` in `hay`. */
export function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    out.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return out;
}

export type SweepToken = Span & { text: string; kind: "date" | "money" | "number" };

/**
 * Coded sweep: every date, amount and other number in a text. Used to make sure nothing
 * numeric escapes the claims list, and again at approval as a guard.
 */
export function sweepNumbersAndDates(text: string): SweepToken[] {
  const taken: SweepToken[] = [];
  const overlaps = (s: number, e: number) => taken.some((t) => s < t.end && e > t.start);
  const add = (s: number, e: number, kind: SweepToken["kind"]) => {
    if (!overlaps(s, e)) taken.push({ start: s, end: e, text: text.slice(s, e), kind });
  };
  for (const pat of DATE_PATTERNS) {
    const re = new RegExp(pat.source, pat.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) add(m.index, m.index + m[0].length, "date");
  }
  const money = /(?:AUD\s?)?-?\$\s?\d[\d,]*(?:\.\d{1,2})?/g;
  let m: RegExpExecArray | null;
  while ((m = money.exec(text))) add(m.index, m.index + m[0].length, "money");
  // Any other token containing a digit: references, phone numbers, unit numbers, times.
  const other = /(?<![\w$])(?:[A-Za-z#]+[-#]?)?\d[\w\-/:.,]*/g;
  while ((m = other.exec(text))) {
    let s = m.index;
    let e = s + m[0].length;
    while (e > s && /[.,:/-]/.test(text[e - 1])) e--;
    if (e > s) add(s, e, "number");
  }
  return taken.sort((a, b) => a.start - b.start);
}

export function normaliseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b(pty|ltd|limited|p\/l|inc|co)\b\.?/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

export type NameMatch =
  | { kind: "exact"; name: string }
  | { kind: "near"; name: string; distance: number }
  | { kind: "none" };

/** Compare a name with reference names: exact (after normalising), near-match, or none. */
export function matchName(name: string, candidates: string[]): NameMatch {
  const n = normaliseName(name);
  if (!n) return { kind: "none" };
  let best: { name: string; distance: number } | null = null;
  for (const c of candidates) {
    const cn = normaliseName(c);
    if (cn === n) return { kind: "exact", name: c };
    const d = levenshtein(n, cn);
    const limit = Math.max(1, Math.floor(Math.max(n.length, cn.length) * 0.2));
    if (d <= limit && (!best || d < best.distance)) best = { name: c, distance: d };
  }
  return best ? { kind: "near", ...best } : { kind: "none" };
}

export function digitsOnly(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "");
}

/** Mask text for display while a re-key is pending: same length, no digits leak. */
export function mask(s: string): string {
  return "•".repeat(Math.max(3, Math.min(s.length, 12)));
}
