// Display rules: dates always as Tue 4 Nov 2026; money with currency (and the GST split on bills).
import { formatCents, formatDate, formatMoney, parseDate, parseMoney, type ClaimView, type DraftContent } from "@vc/shared";

export function showDate(raw: string): string {
  const p = parseDate(raw);
  if (!p) return raw;
  const nice = formatDate(p.iso);
  return /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/.test(raw.trim()) || /^\d{4}-\d{2}-\d{2}$/.test(raw.trim()) ? (raw.includes("-") ? nice : `${nice} (written ${raw})`) : nice;
}

export function showMoney(raw: string, gstRaw?: string | null): string {
  const c = parseMoney(raw);
  if (c == null) return raw;
  const g = gstRaw ? parseMoney(gstRaw) : null;
  return formatMoney(c, g);
}

export function showValue(c: Pick<ClaimView, "type" | "field">, raw: string | null, content?: DraftContent): string {
  if (raw == null) return "";
  if (c.type === "date") return showDate(raw);
  if (c.type === "amount") {
    if (c.field === "total_amount" && content?.kind === "bill") return showMoney(raw, content.bill.gst_amount);
    if (c.field === "gst_amount") {
      const g = parseMoney(raw);
      return g == null ? raw : `${formatCents(g)} GST`;
    }
    return showMoney(raw);
  }
  return raw;
}

export const GROUP_TITLES: Record<string, { title: string; hint: string }> = {
  rekey: { title: "Re-key", hint: "Type the value from the source. The draft value is hidden until you do." },
  mismatch: { title: "Mismatch", hint: "A check disagrees with the draft." },
  unsupported: { title: "Unsupported", hint: "The source doesn't back this statement." },
  omitted: { title: "Omitted", hint: "Asked in the source, not answered in the draft." },
  matched: { title: "Matched", hint: "Every check agrees. Still needs your confirm." },
};

export const KHMER: Record<string, string> = {
  confirm: "បញ្ជាក់",
  correct: "កែតម្រូវ",
  flag: "ផ្ញើទៅអ្នកពិនិត្យ",
  approve: "អនុម័ត",
  rekey: "វាយបញ្ចូលពីឯកសារដើម",
};
