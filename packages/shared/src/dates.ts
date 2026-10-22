// Date parsing and display. Australian convention: numeric dates are day/month/year.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export type ParsedDate = {
  iso: string; // YYYY-MM-DD
  /** Numeric date where day and month could be swapped (e.g. 03/04/2026). */
  ambiguous: boolean;
  /** Weekday written in the text, 0=Sun, if any. */
  statedWeekday: number | null;
};

function pad(n: number) {
  return String(n).padStart(2, "0");
}

export function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function weekdayOf(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function weekdayIndex(word: string | undefined): number | null {
  if (!word) return null;
  const i = WEEKDAYS.indexOf(word.slice(0, 3).toLowerCase());
  return i >= 0 ? i : null;
}

function monthIndex(word: string): number | null {
  const i = MONTHS.indexOf(word.slice(0, 3).toLowerCase());
  return i >= 0 ? i + 1 : null;
}

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

const WD = "(?:(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)[a-z]*,?\\s+)?";
const MON = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?";

/** Regex sources used by the sweep and by parseDate. Order matters (most specific first). */
export const DATE_PATTERNS: RegExp[] = [
  new RegExp(`\\b${WD}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON},?\\s+(\\d{4})\\b`, "gi"), // Tue 4 Nov 2026
  new RegExp(`\\b${WD}${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "gi"), // Nov 4, 2026
  /\b(\d{4})-(\d{2})-(\d{2})\b/g, // 2026-11-04
  /\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/g, // 04/11/2026
  new RegExp(`\\b${WD}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}(?![a-z])`, "gi"), // Friday 7 November (no year)
];

/**
 * Parse one date string. `refYear` fills in a missing year.
 * Returns null if it is not a date or not a valid calendar date.
 */
export function parseDate(text: string, refYear = new Date().getUTCFullYear()): ParsedDate | null {
  const s = text.trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(new RegExp(`^${WD}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON},?\\s+(\\d{4})$`, "i")))) {
    const [, wd, d, mon, y] = m;
    return build(Number(y), monthIndex(mon)!, Number(d), false, weekdayIndex(wd));
  }
  if ((m = s.match(new RegExp(`^${WD}${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})$`, "i")))) {
    const [, wd, mon, d, y] = m;
    return build(Number(y), monthIndex(mon)!, Number(d), false, weekdayIndex(wd));
  }
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    return build(Number(m[1]), Number(m[2]), Number(m[3]), false, null);
  }
  if ((m = s.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/))) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(Number(m[3]));
    const ambiguous = a <= 12 && b <= 12 && a !== b;
    return build(y, b, a, ambiguous, null);
  }
  if ((m = s.match(new RegExp(`^${WD}(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON}$`, "i")))) {
    const [, wd, d, mon] = m;
    return build(refYear, monthIndex(mon)!, Number(d), false, weekdayIndex(wd));
  }
  return null;
}

function build(y: number, mo: number, d: number, ambiguous: boolean, statedWeekday: number | null): ParsedDate | null {
  if (!isValidYmd(y, mo, d)) return null;
  return { iso: `${y}-${pad(mo)}-${pad(d)}`, ambiguous, statedWeekday };
}

/** Display rule: always `Tue 4 Nov 2026`, never `04/11/26`. */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!isValidYmd(y, m, d)) return iso;
  return `${WEEKDAY_SHORT[weekdayOf(iso)]} ${d} ${MONTH_SHORT[m - 1]} ${y}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export const WEEKDAY_NAMES = WEEKDAY_SHORT;
