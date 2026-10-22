// Panel 3 drives the screen: claims grouped so problems come first. No confidence scores are
// shown, on purpose: a "98% confident" badge trains people to stop looking.
import { CLAIM_GROUP_ORDER, type Check, type ClaimView, type DraftContent } from "@vc/shared";
import { useEffect, useRef } from "react";
import { GROUP_TITLES, KHMER, showValue } from "../lib/format";

export type Mode = { kind: "rekey" | "correct" | "flag" | "note"; value: string } | null;

export type DisplayClaim = ClaimView & { syncing: boolean };

type Props = {
  claims: DisplayClaim[];
  content: DraftContent;
  selectedId: string | null;
  mode: Mode;
  setMode: (m: Mode) => void;
  onSelect: (id: string) => void;
  onAction: (action: "confirm" | "correct" | "flag" | "rekey", value?: string, note?: string) => void;
  onMove: (delta: number) => void;
  disabled: string | null;
  khmer: boolean;
  review: boolean;
};

const CHECK_STYLE: Record<Check["result"], string> = {
  agree: "bg-emerald-50 text-emerald-800 border-emerald-200",
  disagree: "bg-red-50 text-red-800 border-red-200",
  not_found: "bg-amber-50 text-amber-800 border-amber-200",
  info: "bg-slate-50 text-slate-600 border-slate-200",
};
const CHECK_ICON: Record<Check["result"], string> = { agree: "✓", disagree: "✗", not_found: "?", info: "i" };

const CHECK_NAMES: Record<string, string> = {
  independent_check: "independent check",
  supplier_list: "supplier list",
  tenancy_register: "tenancy register",
  known_contact: "known contact",
  recipients_match_sender: "recipient",
  bank_details_match: "bank record",
  abn_checksum: "ABN checksum",
  abn_matches_record: "ABN record",
  gst_one_eleventh: "GST 1/11",
  line_items_sum: "line items",
  totals_reconcile: "totals",
  equals_source: "equals source",
  amount_parses: "parses",
  date_valid: "valid date",
  date_unambiguous: "unambiguous",
  weekday_matches: "weekday",
  promise_not_past: "not past",
  account_code_valid: "chart of accounts",
  account_code_usual: "usual code",
  property_known: "managed property",
  own_name: "our name",
  subject_from_source: "from source",
};

function StatusIcon({ c }: { c: DisplayClaim }) {
  if (c.syncing) return <span className="text-slate-400" title="Saving">…</span>;
  if (c.status === "confirmed") return <span className="text-emerald-600" title="Confirmed">✓</span>;
  if (c.status === "corrected") return <span className="text-accent" title="Corrected">✎</span>;
  if (c.status === "flagged") return <span className="text-amber-600" title="Flagged">⚑</span>;
  return <span className="text-slate-300" title="Undecided">○</span>;
}

export function ClaimsPanel(p: Props) {
  const groups = CLAIM_GROUP_ORDER.map((g) => ({ g, items: p.claims.filter((c) => c.group === g) })).filter((x) => x.items.length);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-claim-id="${p.selectedId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [p.selectedId]);

  return (
    <div className="flex h-full flex-col">
      <div ref={listRef} className="min-h-0 flex-1 overflow-auto p-2" data-testid="claims-panel">
        {groups.map(({ g, items }) => (
          <section key={g} className="mb-3">
            <h3 className="mb-1 flex items-baseline gap-2 whitespace-nowrap px-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500" title={GROUP_TITLES[g].hint}>
              {GROUP_TITLES[g].title}
              <span className="truncate font-normal normal-case text-slate-400">
                {items.filter((c) => c.status === "undecided").length} open · {GROUP_TITLES[g].hint}
              </span>
            </h3>
            <div className="flex flex-col gap-1">
              {items.map((c) => (
                <ClaimRow key={c.id} c={c} {...p} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ClaimRow({ c, selectedId, content, mode, setMode, onSelect, onAction, onMove, disabled, khmer, review }: { c: DisplayClaim } & Props) {
  const active = c.id === selectedId;
  const inputRef = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const compact = c.group === "matched" && !active;
  useEffect(() => {
    if (active && mode) inputRef.current?.focus();
  }, [active, mode]);

  const value = c.rekey_pending ? null : showValue(c, c.draft_value, content);
  const source = c.rekey_pending ? null : c.source_value ? showValue(c, c.source_value, content) : null;
  const k = (key: keyof typeof KHMER) => (khmer ? <span className="ml-1 text-[10px] text-slate-500">{KHMER[key]}</span> : null);

  const submitMode = () => {
    if (!mode) return;
    if (mode.kind === "rekey") onAction("rekey", mode.value);
    else if (mode.kind === "correct") onAction("correct", mode.value);
    else if (mode.kind === "flag") onAction("flag", undefined, mode.value);
    else if (mode.kind === "note") onAction("confirm", undefined, mode.value);
  };

  return (
    <div
      data-testid="claim-row"
      data-claim-id={c.id}
      data-status={c.syncing ? "saving" : c.status}
      data-group={c.group}
      data-active={active ? "true" : undefined}
      data-rekey={c.rekey_pending ? "pending" : undefined}
      onClick={() => onSelect(c.id)}
      className={`cursor-pointer rounded border px-2 ${compact ? "py-1" : "py-1.5"} ${active ? "border-accent bg-accent-soft/60 ring-1 ring-accent" : "border-slate-200 bg-white hover:border-slate-300"}`}
    >
      <div className="flex items-baseline gap-2">
        <StatusIcon c={c} />
        <span className="w-24 shrink-0 text-slate-500">{c.label}</span>
        <span className={`min-w-0 flex-1 ${compact ? "truncate" : "break-words"} ${c.rekey_pending ? "italic text-slate-400" : "font-medium"}`}>
          {c.rekey_pending ? (c.syncing ? "typed, checking…" : "type from source") : value}
        </span>
      </div>
      {!compact && (
        <div className="mt-1 pl-6">
          {source != null && source !== value && (
            <div className="text-[12px] text-slate-600">
              <span className="text-slate-400">Source </span>
              {source}
            </div>
          )}
          <div className="mt-1 flex flex-wrap gap-1">
            {c.checks.map((ch, i) => (
              <span key={i} className={`rounded border px-1 text-[11px] ${CHECK_STYLE[ch.result]}`} title={ch.detail}>
                {CHECK_ICON[ch.result]} {CHECK_NAMES[ch.check] ?? ch.check}
              </span>
            ))}
          </div>
          {active && (
            <div className="mt-1.5 space-y-1 text-[12px] text-slate-700">
              {c.checks
                .filter((ch) => ch.result !== "agree")
                .map((ch, i) => (
                  <div key={i}>
                    {CHECK_ICON[ch.result]} {ch.detail}
                  </div>
                ))}
              {c.last_decision && (
                <div className="text-slate-500">
                  {c.last_decision.action} by {c.last_decision.by}
                  {c.last_decision.note ? `: "${c.last_decision.note}"` : ""}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {active && (
        <div className="mt-2 pl-6" onClick={(e) => e.stopPropagation()}>
          {disabled && <div className="mb-1 text-[12px] text-amber-700">{disabled}</div>}
          {!mode && c.rekey_pending && !c.syncing && !disabled && (
            <div className="mb-1.5 text-[12px] text-slate-600">
              Press <kbd>Enter</kbd> and type the {c.label.toLowerCase()} from {c.source_span ? "the source" : "the client record under the source (the email doesn't state it)"}.{k("rekey")}
            </div>
          )}
          {mode && (
            <div className="mb-1.5">
              <label className="mb-0.5 block text-[11px] text-slate-500">
                {mode.kind === "rekey" && (c.source_span ? `Type the ${c.label.toLowerCase()} from the source` : `Type the ${c.label.toLowerCase()} from the client record under the source`)}
                {mode.kind === "correct" && (c.type === "question" ? "Write the answer to add to the draft" : "Correct value")}
                {mode.kind === "flag" && "Note for the senior reviewer"}
                {mode.kind === "note" && "Why is this OK to leave as it is?"}
                {mode.kind === "rekey" && k("rekey")}
              </label>
              <input
                ref={inputRef}
                data-testid={`${mode.kind}-input`}
                className="w-full rounded border border-slate-300 bg-white px-2 py-1 font-mono"
                value={mode.value}
                autoComplete="off"
                spellCheck={false}
                onChange={(e) => setMode({ ...mode, value: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey) {
                    e.preventDefault();
                    if (mode.value.trim() || mode.kind === "correct") submitMode();
                  } else if (e.key === "Escape") {
                    e.preventDefault();
                    setMode(null);
                    (e.target as HTMLElement).blur();
                  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    onMove(e.key === "ArrowDown" ? 1 : -1);
                  }
                }}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-1.5">
            {c.rekey_pending ? (
              <button
                className="rounded bg-accent px-2 py-0.5 text-white disabled:opacity-40"
                disabled={!!disabled || (!!mode && !mode.value.trim())}
                onClick={() => (mode ? submitMode() : setMode({ kind: "rekey", value: "" }))}
              >
                {mode?.kind === "rekey" ? "Check" : "Type value"} <kbd>Enter</kbd>
              </button>
            ) : (
              <button
                className="rounded bg-emerald-700 px-2 py-0.5 text-white disabled:opacity-40"
                disabled={!!disabled || (!mode && c.rekey_mismatch)}
                onClick={() => (mode ? submitMode() : onAction("confirm"))}
              >
                {mode?.kind === "correct" ? "Save correction" : mode?.kind === "flag" ? "Send flag" : "Confirm"} <kbd>Enter</kbd>
                {k("confirm")}
              </button>
            )}
            {c.field !== "to" && c.field !== "subject" && (
              <button className="rounded border border-slate-300 bg-white px-2 py-0.5 disabled:opacity-40" disabled={!!disabled} onClick={() => setMode({ kind: "correct", value: c.type === "question" ? "" : (c.draft_value ?? "") })}>
                Correct <kbd>E</kbd>
                {k("correct")}
              </button>
            )}
            {!review && (
              <button className="rounded border border-slate-300 bg-white px-2 py-0.5 disabled:opacity-40" disabled={!!disabled} onClick={() => setMode({ kind: "flag", value: "" })}>
                Flag <kbd>F</kbd>
                {k("flag")}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
