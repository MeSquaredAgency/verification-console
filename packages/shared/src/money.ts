// Money handling in integer cents. Display rule: `$1,320.00 AUD (incl. $120.00 GST)`.

/** Parse "$1,320.00", "1320", "AUD 1,320.50", "-$5.00" to cents. Null if not money. */
export function parseMoney(text: string | null | undefined): number | null {
  if (text == null) return null;
  const s = text.replace(/\s|AUD|aud|\$/g, "").replace(/,/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) return null;
  const neg = s.startsWith("-");
  const [whole, frac = ""] = s.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
  return neg ? -cents : cents;
}

export function centsToDecimal(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? "-" : ""}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatCents(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString("en-AU");
  return `${neg ? "-" : ""}$${whole}.${String(abs % 100).padStart(2, "0")}`;
}

export function formatMoney(totalCents: number, gstCents?: number | null): string {
  const base = `${formatCents(totalCents)} AUD`;
  return gstCents == null ? base : `${base} (incl. ${formatCents(gstCents)} GST)`;
}

/** GST is one eleventh of a GST-inclusive total, rounded to the cent. */
export function gstOf(totalCents: number): number {
  return Math.round(totalCents / 11);
}
