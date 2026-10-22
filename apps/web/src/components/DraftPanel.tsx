// Panel 2: the output exactly as it will be released. Every occurrence of the selected claim is
// highlighted, so a figure that appears twice is checked twice.
import { BILL_FIELDS, occurrences, type ClaimView, type DraftContent } from "@vc/shared";
import { useState } from "react";
import { showValue } from "../lib/format";

const BILL_LABELS: Record<string, string> = {
  supplier_name: "Supplier",
  supplier_abn: "ABN",
  invoice_number: "Invoice no.",
  invoice_date: "Invoice date",
  due_date: "Due date",
  total_amount: "Amount",
  gst_amount: "GST",
  account_code: "Account code",
  property: "Property",
  bank_bsb: "BSB",
  bank_account: "Bank account",
  description: "Description",
};

type Props = {
  content: DraftContent;
  claims: ClaimView[];
  selected: ClaimView | null;
  maskedSpans: { start: number; end: number }[];
  onSelect: (id: string) => void;
  canEdit: boolean;
  editBlockedReason: string | null;
  onSaveBody: (body: string) => Promise<void>;
};

export function DraftPanel(p: Props) {
  return p.content.kind === "bill" ? <BillDraft {...p} /> : <ReplyDraft {...p} />;
}

function BillDraft({ content, claims, selected, onSelect }: Props) {
  if (content.kind !== "bill") return null;
  return (
    <div className="h-full overflow-auto p-3" data-testid="draft-panel">
      <div className="grid gap-1.5">
        {BILL_FIELDS.map((f) => {
          const claim = claims.find((c) => c.field === f);
          const value = content.bill[f];
          const hidden = claim?.rekey_pending;
          const active = selected?.field === f;
          return (
            <button
              key={f}
              type="button"
              tabIndex={-1}
              onClick={() => claim && onSelect(claim.id)}
              className={`grid grid-cols-[110px_1fr] items-start gap-2 rounded border px-2 py-1.5 text-left ${active ? "border-accent bg-accent-soft" : "border-slate-200 bg-white"}`}
              data-field={f}
            >
              <span className="text-slate-500">{BILL_LABELS[f]}</span>
              <span className={hidden ? "italic text-slate-400" : "font-medium"}>
                {hidden ? "hidden until typed" : value == null ? <span className="text-slate-400">(empty)</span> : claim ? showValue(claim, value, content) : value}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ReplyDraft({ content, claims, selected, maskedSpans, onSelect, canEdit, editBlockedReason, onSaveBody }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  if (content.kind !== "reply") return null;
  const body = content.reply.body;

  // Build highlight segments: masked values, the selected claim, and other occurrences of it.
  type Mark = { start: number; end: number; cls: string; claimId?: string };
  const marks: Mark[] = maskedSpans.map((s) => ({ ...s, cls: "masked" }));
  if (selected?.draft_span) marks.push({ ...selected.draft_span, cls: "hl", claimId: selected.id });
  if (selected?.draft_value && !selected.rekey_pending && selected.draft_value.length >= 2) {
    for (const at of occurrences(body, selected.draft_value)) {
      if (at !== selected.draft_span?.start) marks.push({ start: at, end: at + selected.draft_value.length, cls: "hl-other" });
    }
  }
  const clickable = claims.filter((c) => c.draft_span && c.field == null);
  const bounds = new Set<number>([0, body.length]);
  for (const m of [...marks, ...clickable.map((c) => c.draft_span!)]) {
    bounds.add(m.start);
    bounds.add(m.end);
  }
  const cuts = [...bounds].filter((b) => b >= 0 && b <= body.length).sort((a, b) => a - b);
  const segs: React.ReactNode[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i];
    const e = cuts[i + 1];
    const m = marks.filter((x) => x.start <= s && x.end >= e);
    const cls = m.find((x) => x.cls === "masked")?.cls ?? m.find((x) => x.cls === "hl")?.cls ?? m.find((x) => x.cls === "hl-other")?.cls ?? "";
    const owner = clickable.filter((c) => c.draft_span!.start <= s && c.draft_span!.end >= e).sort((a, b) => a.draft_span!.end - a.draft_span!.start - (b.draft_span!.end - b.draft_span!.start))[0];
    segs.push(
      <span key={s} className={`${cls} ${owner ? "cursor-pointer" : ""}`} data-hl={cls === "hl" ? "1" : undefined} onClick={owner ? () => onSelect(owner.id) : undefined}>
        {body.slice(s, e)}
      </span>,
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="draft-panel">
      <div className="border-b bg-slate-50 px-3 py-2 text-[12px] text-slate-600">
        <div>
          <span className="text-slate-400">To </span>
          <span className={selected?.field === "to" ? "hl" : ""}>{content.reply.to.join(", ") || "(no recipient)"}</span>
        </div>
        <div>
          <span className="text-slate-400">Subject </span>
          <span className={selected?.field === "subject" ? "hl" : ""}>{content.reply.subject}</span>
        </div>
      </div>
      {editing ? (
        <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
          <textarea
            className="min-h-0 flex-1 resize-none rounded border border-slate-300 p-2 font-[inherit] leading-relaxed"
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="draft-editor"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
            }}
          />
          <div className="flex gap-2">
            <button
              className="rounded bg-slate-800 px-3 py-1 text-white disabled:opacity-50"
              disabled={saving || text === body}
              onClick={async () => {
                setSaving(true);
                try {
                  await onSaveBody(text);
                  setEditing(false);
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "Re-checking…" : "Save and re-check"}
            </button>
            <button className="rounded px-3 py-1 text-slate-600" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <span className="ml-auto self-center text-[11px] text-slate-500">Changed claims will need deciding again.</span>
          </div>
        </div>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 leading-relaxed" data-testid="draft-body">
            {segs}
          </div>
          <div className="flex items-center gap-2 border-t px-3 py-1.5">
            <button
              className="rounded border border-slate-300 bg-white px-2 py-0.5 text-[12px] disabled:opacity-40"
              disabled={!canEdit || !!editBlockedReason}
              title={editBlockedReason ?? ""}
              onClick={() => {
                setText(body);
                setEditing(true);
              }}
            >
              Edit text
            </button>
            {editBlockedReason && <span className="text-[11px] text-slate-500">{editBlockedReason}</span>}
          </div>
        </>
      )}
    </div>
  );
}
