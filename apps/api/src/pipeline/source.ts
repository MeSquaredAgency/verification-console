// Turning a source (PDF or pasted email) into plain text plus a layout map, so that
// spans found in the text can be drawn back onto the rendered page in Panel 1.
import type { PdfPage, PdfTextItem } from "@vc/shared";
import { getDocumentProxy } from "unpdf";

export type PdfExtraction = { text: string; pages: PdfPage[] };

type RawItem = { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean };

export async function extractPdf(bytes: Uint8Array): Promise<PdfExtraction> {
  // pdf.js may detach the buffer it is given, so pass a copy.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  let text = "";
  const pages: PdfPage[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    if (p > 1) text += "\n\n";
    const pageStart = text.length;
    const items: PdfTextItem[] = [];
    let prev: { y: number; xEnd: number } | null = null;
    for (const raw of content.items as RawItem[]) {
      if (typeof raw.str !== "string" || raw.str.length === 0) continue;
      const x = raw.transform[4];
      const y = raw.transform[5];
      const h = raw.height || Math.abs(raw.transform[3]);
      if (prev) {
        if (Math.abs(prev.y - y) > 2) text += "\n";
        else if (!text.endsWith(" ") && !raw.str.startsWith(" ") && x - prev.xEnd > 1) text += " ";
      }
      const s = text.length;
      text += raw.str;
      items.push({ s, e: text.length, x, y, w: raw.width, h });
      prev = { y, xEnd: x + raw.width };
    }
    pages.push({ index: p - 1, width: viewport.width, height: viewport.height, start: pageStart, end: text.length, items });
  }
  await pdf.cleanup?.();
  return { text, pages };
}

export type EmailMeta = {
  from_name: string | null;
  from_email: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
  /** Offset where quoted earlier messages begin, collapsed in Panel 1. */
  quoted_from: number | null;
};

/** Parse a pasted email: RFC-822-style headers, a blank line, then the body. */
export function parseEmail(raw: string): { text: string; meta: EmailMeta } {
  const text = raw.replace(/\r\n/g, "\n");
  const header = (name: string) => {
    const m = text.match(new RegExp(`^${name}:[ \\t]*(.+)$`, "mi"));
    return m ? m[1].trim() : null;
  };
  const from = header("From");
  let from_name: string | null = null;
  let from_email: string | null = null;
  if (from) {
    const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) {
      from_name = m[1].trim() || null;
      from_email = m[2].trim().toLowerCase();
    } else if (/@/.test(from)) {
      from_email = from.trim().toLowerCase();
    }
  }
  const q = text.search(/^(On .+wrote:|-{2,}\s*Original Message\s*-{2,}|>)/m);
  return {
    text,
    meta: { from_name, from_email, to: header("To"), subject: header("Subject"), date: header("Date"), quoted_from: q >= 0 ? q : null },
  };
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
