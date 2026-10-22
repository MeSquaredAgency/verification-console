import { parseDate } from "./dates";
import { parseMoney } from "./money";
import { digitsOnly, normaliseName } from "./text";
import type { ClaimType } from "./schemas";

/**
 * Canonical form of a claim value, used to compare a draft value, a re-keyed value and a
 * source value. Two values are equal iff their canonical forms are equal.
 */
export function canonical(type: ClaimType, value: string | null | undefined, refYear?: number): string {
  if (value == null) return "";
  const v = value.trim();
  switch (type) {
    case "amount": {
      const c = parseMoney(v);
      return c == null ? v.toLowerCase() : `cents:${c}`;
    }
    case "date": {
      const d = parseDate(v, refYear);
      return d ? `date:${d.iso}` : v.toLowerCase();
    }
    case "abn":
    case "bank":
    case "phone":
      return `digits:${digitsOnly(v)}`;
    case "name":
      return normaliseName(v);
    case "email":
      return v.toLowerCase();
    default:
      return v.toLowerCase().replace(/\s+/g, " ");
  }
}

export function sameValue(type: ClaimType, a: string | null | undefined, b: string | null | undefined, refYear?: number) {
  return canonical(type, a, refYear) === canonical(type, b, refYear);
}
