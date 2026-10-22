// Generates fixtures/bills/*.pdf, fixtures/emails/*.txt and fixtures/answer-keys.json from fixtures/data.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { BILLS, EMAILS, answerKeys, type BillFixture } from "../fixtures/data";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures");

async function billPdf(b: BillFixture): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Fixed metadata so the PDFs are byte-for-byte reproducible.
  doc.setCreationDate(new Date("2026-10-01T00:00:00Z"));
  doc.setModificationDate(new Date("2026-10-01T00:00:00Z"));
  doc.setProducer("verification-console fixtures");
  doc.setCreator("verification-console fixtures");
  const page = doc.addPage([595, 842]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 790;
  const line = (text: string, opts: { x?: number; size?: number; b?: boolean } = {}) => {
    page.drawText(text, { x: opts.x ?? 50, y, size: opts.size ?? 10, font: opts.b ? bold : font, color: rgb(0.1, 0.1, 0.1) });
  };
  const row = (left: string, right: string, b = false) => {
    line(left, { b });
    const f = b ? bold : font;
    page.drawText(right, { x: 545 - f.widthOfTextAtSize(right, 10), y, size: 10, font: f });
    y -= 16;
  };
  line(b.supplier.name, { size: 16, b: true });
  page.drawText("TAX INVOICE", { x: 430, y, size: 14, font: bold });
  y -= 20;
  line(`ABN: ${b.supplier.abn}`);
  y -= 14;
  line(`${b.supplier.address}  |  Ph ${b.supplier.phone}`);
  y -= 30;
  line("Bill to: APN Demo Realty (fictional), as agent for the owner");
  y -= 14;
  line(`Property: ${b.property}`);
  y -= 24;
  line(`Invoice No: ${b.invoice_no}`);
  y -= 14;
  line(`Invoice Date: ${b.invoice_date}`);
  y -= 14;
  line(`Due Date: ${b.due_date}`);
  y -= 28;
  row("Description", "Amount", true);
  for (const it of b.items) row(it.desc, it.amount);
  y -= 6;
  row("Subtotal", b.subtotal);
  if (b.gst) row("GST", b.gst);
  row("Total due", b.total, true);
  y -= 20;
  if (b.bank) {
    line(`Payment by EFT: BSB ${b.bank.bsb}  Account ${b.bank.account}  Account name: ${b.bank.name}`);
    y -= 14;
  }
  for (const n of b.notes) {
    line(n);
    y -= 14;
  }
  return doc.save({ useObjectStreams: false });
}

async function main() {
  mkdirSync(path.join(root, "bills"), { recursive: true });
  mkdirSync(path.join(root, "emails"), { recursive: true });
  for (const b of BILLS) writeFileSync(path.join(root, "bills", `${b.id}.pdf`), await billPdf(b));
  for (const e of EMAILS) writeFileSync(path.join(root, "emails", `${e.id}.txt`), e.raw);
  writeFileSync(path.join(root, "answer-keys.json"), JSON.stringify(answerKeys(), null, 2) + "\n");
  console.log(`Wrote ${BILLS.length} bills, ${EMAILS.length} emails and answer keys to ${root}`);
}

main();
