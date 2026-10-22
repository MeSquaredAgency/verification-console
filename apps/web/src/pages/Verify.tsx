// The verification screen. Panel 3 drives it; Panels 1 and 2 follow the selected claim.
// Keyboard: J/K move · Enter confirm · E correct · F flag · Ctrl+Enter approve.
import { CLAIM_GROUP_ORDER, type ApproveResult, type DraftContent, type TaskView } from "@vc/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ClaimsPanel, type DisplayClaim, type Mode } from "../components/ClaimsPanel";
import { DraftPanel } from "../components/DraftPanel";
import { SourcePanel } from "../components/SourcePanel";
import { useToast } from "../components/Toast";
import { api, ApiError } from "../lib/api";
import { formatDate } from "@vc/shared";
import { KHMER, showValue } from "../lib/format";
import { enqueue, flush, pending, subscribe } from "../lib/outbox";
import { useMe } from "../lib/useMe";

const TYPE_LABEL = { supplier_bill: "Supplier bill", tenant_email: "Tenant email" } as const;

export function VerifyPage() {
  const { id } = useParams<{ id: string }>();
  const me = useMe();
  const nav = useNavigate();
  const toast = useToast();
  const [view, setView] = useState<TaskView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>(null);
  const [outboxTick, setOutboxTick] = useState(0);
  const [online, setOnline] = useState(navigator.onLine);
  const [result, setResult] = useState<ApproveResult | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const selectedAt = useRef(Date.now());
  const advanceAfterSync = useRef<string | null>(null);
  const lastBeat = useRef(0);

  const setMode = useCallback((m: Mode) => setModeState(m), []);

  // Load: open (and lock) the task if it's workable, otherwise view read-only.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        let v: TaskView;
        try {
          v = await api<TaskView>(`/api/tasks/${id}/open`, { method: "POST" });
        } catch (e) {
          if (e instanceof ApiError && (e.status === 409 || e.status === 403)) {
            v = await api<TaskView>(`/api/tasks/${id}`);
            if (e.status === 409 && v.status !== "released") setError(e.message);
          } else throw e;
        }
        if (!cancelled) setView(v);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  // Outbox events: server views replace ours as decisions land.
  useEffect(() => {
    const off = subscribe((e) => {
      setOutboxTick((t) => t + 1);
      if (e.kind === "synced" && e.decision.taskId === id) {
        setView(e.task);
        setOnline(true);
        if (e.canary === "caught") toast("Good catch: that was a seeded test error. The true value is back.", "good");
        else if (e.outcome === "mismatch") toast("Your typed value doesn't match the draft. Correct it or flag it.", "bad");
      } else if (e.kind === "rejected" && e.decision.taskId === id) {
        toast(`Not saved: ${e.message}`, "bad");
        void api<TaskView>(`/api/tasks/${id}`).then(setView);
      } else if (e.kind === "offline") setOnline(false);
    });
    const on = () => {
      setOnline(true);
      void flush();
    };
    const offl = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", offl);
    void flush();
    return () => {
      off();
      window.removeEventListener("online", on);
      window.removeEventListener("offline", offl);
    };
  }, [id, toast]);

  const myPending = useMemo(() => pending(id), [id, outboxTick]);
  const correctionPending = myPending.some((d) => d.action === "correct");

  // Merge local, not-yet-saved decisions over the server view.
  const claims: DisplayClaim[] = useMemo(() => {
    if (!view) return [];
    const byClaim = new Map(myPending.map((d) => [d.claim_id, d]));
    const merged = view.claims.map((c) => {
      const d = byClaim.get(c.id);
      if (!d) return { ...c, syncing: false };
      const status = d.action === "confirm" ? "confirmed" : d.action === "flag" ? "flagged" : c.status === "undecided" ? ("confirmed" as const) : c.status;
      return { ...c, status, syncing: true };
    });
    return merged.sort((a, b) => CLAIM_GROUP_ORDER.indexOf(a.group) - CLAIM_GROUP_ORDER.indexOf(b.group));
  }, [view, myPending]);

  const order = claims.map((c) => c.id);
  const selected = claims.find((c) => c.id === selectedId) ?? null;
  const open = claims.filter((c) => c.status === "undecided").length;
  const review = view?.status === "second_review";
  const readOnly = !view || !view.lock.mine || !["in_review", "second_review"].includes(view.status);
  const unresolvedFlags = review ? claims.filter((c) => c.status === "flagged").length : 0;
  const canApprove = !readOnly && open === 0 && unresolvedFlags === 0 && myPending.length === 0 && online && !busy;

  // After a re-key or correction lands, move on (or stay to fix a mismatch).
  // Otherwise keep the selection valid: default to the first undecided claim.
  useEffect(() => {
    if (!view) return;
    const waiting = advanceAfterSync.current;
    if (waiting && !pending(id).some((d) => d.claim_id === waiting)) {
      advanceAfterSync.current = null;
      const c = claims.find((x) => x.id === waiting);
      if (c && c.status === "undecided") {
        setSelectedId(c.id);
        selectedAt.current = Date.now();
        setModeState(c.rekey_mismatch ? { kind: "correct", value: "" } : null);
        return;
      }
      const i = order.indexOf(waiting);
      const next = (i >= 0 ? [...claims.slice(i + 1), ...claims.slice(0, i)] : claims).find((x) => x.status === "undecided");
      if (next) select(next.id);
      else setModeState(null);
      return;
    }
    if (!selectedId || !view.claims.some((c) => c.id === selectedId)) {
      const first = claims.find((c) => c.status === "undecided") ?? claims[0];
      if (first) select(first.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  function select(cid: string) {
    setSelectedId(cid);
    selectedAt.current = Date.now();
    const c = view?.claims.find((x) => x.id === cid);
    setModeState(null);
  }

  const move = useCallback(
    (delta: number) => {
      if (!order.length) return;
      const i = Math.max(0, order.indexOf(selectedId ?? ""));
      select(order[(i + delta + order.length) % order.length]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [order.join(","), selectedId, view],
  );

  const advance = (fromId: string) => {
    const i = order.indexOf(fromId);
    for (let k = 1; k <= order.length; k++) {
      const c = claims.find((x) => x.id === order[(i + k) % order.length]);
      if (c && c.status === "undecided" && c.id !== fromId) return select(c.id);
    }
    setModeState(null);
  };

  const heartbeat = () => {
    if (readOnly || Date.now() - lastBeat.current < 60_000) return;
    lastBeat.current = Date.now();
    void api(`/api/tasks/${id}/heartbeat`, { method: "POST" }).catch(() => {});
  };

  const disabledReason = readOnly
    ? view?.status === "released"
      ? "Released"
      : view?.lock.holder && !view.lock.mine
        ? `Open by ${view.lock.holder}`
        : "Read only"
    : correctionPending
      ? online
        ? "Saving your correction…"
        : "Corrections need a connection. Your other decisions are saved on this device."
      : null;

  const act = (action: "confirm" | "correct" | "flag" | "rekey", value?: string, note?: string) => {
    if (!selected || disabledReason) return;
    if (action === "confirm") {
      if (selected.rekey_pending) return setModeState({ kind: "rekey", value: "" });
      if (selected.rekey_mismatch) return setModeState({ kind: "correct", value: "" });
      if ((selected.group === "unsupported" || selected.group === "omitted") && !note) return setModeState({ kind: "note", value: "" });
    }
    if (action === "correct" && !online) {
      toast("Corrections change the draft and need a connection. Confirm and flag still work offline.", "bad");
      return;
    }
    enqueue({ taskId: id!, claim_id: selected.id, action, value: value ?? null, note: note ?? null, time_ms: Date.now() - selectedAt.current });
    heartbeat();
    setModeState(null);
    if (action === "correct" || action === "rekey") {
      advanceAfterSync.current = selected.id; // wait for the server's answer
      return;
    }
    advance(selected.id);
  };

  const approve = async () => {
    if (!canApprove) return;
    setBusy(true);
    try {
      const r = await api<{ result: ApproveResult; task: TaskView }>(`/api/tasks/${id}/approve`, { method: "POST" });
      setView(r.task);
      setResult(r.result);
      if (r.result.outcome === "second_review") {
        toast("Sent to a senior reviewer for second review.", "good");
        nav("/");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  const saveBody = async (body: string) => {
    try {
      const r = await api<{ task: TaskView; canary: string | null }>(`/api/tasks/${id}/draft`, { method: "PUT", json: { kind: "body", body } });
      setView(r.task);
      if (r.canary === "caught") toast("Good catch: that was a seeded test error. The true value is back.", "good");
      toast("Draft re-checked. Changed claims need deciding again.");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
      throw e;
    }
  };

  // Keyboard flow.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "p" || e.key === "s")) {
        e.preventDefault(); // no printing or saving the source
        return;
      }
      if (result || rejecting !== null) return;
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void approve();
        return;
      }
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "TEXTAREA") return;
      heartbeat();
      const key = e.key.toLowerCase();
      if (key === "j" || e.key === "ArrowDown") {
        e.preventDefault();
        move(1);
      } else if (key === "k" || e.key === "ArrowUp") {
        e.preventDefault();
        move(-1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        act("confirm");
      } else if (key === "e" && selected && selected.field !== "to" && selected.field !== "subject" && !disabledReason) {
        e.preventDefault();
        setModeState({ kind: "correct", value: selected.type === "question" ? "" : (selected.draft_value ?? "") });
      } else if (key === "f" && !review && !disabledReason) {
        e.preventDefault();
        setModeState({ kind: "flag", value: "" });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (error && !view) return <div className="p-6 text-red-700">{error}</div>;
  if (!view) return <div className="p-6 text-slate-500">Loading…</div>;

  const content = view.draft.content;
  const editBlocked = view.masked_spans.length ? "Re-key the hidden values first" : myPending.length ? "Saving decisions…" : !online ? "Offline" : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b bg-white px-3 py-1.5">
        <div className="min-w-0">
          <div className="truncate font-semibold" data-testid="task-heading">
            {view.client_name} · {TYPE_LABEL[view.type]} · Tier {view.tier}
          </div>
          <div className="truncate text-[11px] text-slate-500">
            {view.title}
            {view.tier_reasons.length > 0 && ` · ${view.tier_reasons.map((r) => r.split(": ").slice(1).join(": ") || r).join(" · ")}`}
          </div>
        </div>
        {review && view.operator_approval && (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-[12px] text-amber-900">
            Second review · approved by {view.operator_approval.by}
            {view.needs_licensed_reviewer ? " · licensed APN reviewer required" : ""}
          </span>
        )}
        {error && <span className="text-[12px] text-amber-700">{error}</span>}
        <div className="ml-auto flex items-center gap-2">
          {!readOnly && (
            <button className="rounded border border-slate-300 px-2 py-1 text-[12px]" onClick={() => setRejecting("")}>
              Reject · redraft
            </button>
          )}
          <button
            data-testid="approve"
            disabled={!canApprove}
            onClick={approve}
            className="rounded bg-emerald-700 px-3 py-1 font-medium text-white disabled:bg-slate-200 disabled:text-slate-500"
          >
            {review ? "Approve and release" : "Approve"}
            {" · "}
            {open > 0 ? `${open} claim${open === 1 ? "" : "s"} left` : unresolvedFlags ? `${unresolvedFlags} flag${unresolvedFlags === 1 ? "" : "s"} to resolve` : myPending.length ? "saving…" : "ready"}
            {view.flags.khmer_ui_hints && <span className="ml-1 text-[10px]">{KHMER.approve}</span>}
          </button>
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-[1.05fr_0.95fr_1fr] gap-2 p-2">
        <PanelFrame title="1 Source" sub={view.source.kind === "pdf" ? `${view.source.filename} · read-only` : "Email · read-only"}>
          <SourcePanel taskId={view.id} reference={view.reference} source={view.source} span={selected?.source_span ?? null} watermark={`${me.email} · ${new Date().toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short" })}`} />
        </PanelFrame>
        <PanelFrame title="2 Draft" sub={`${content.kind === "bill" ? "Bill entry" : "Reply"} · version ${view.draft.version}`}>
          <DraftPanel content={content} claims={claims} selected={selected} maskedSpans={view.masked_spans} onSelect={select} canEdit={!readOnly} editBlockedReason={editBlocked} onSaveBody={saveBody} />
        </PanelFrame>
        <PanelFrame title="3 Verify" sub="Claims, problems first">
          <ClaimsPanel
            claims={claims}
            content={content}
            selectedId={selectedId}
            mode={mode}
            setMode={setMode}
            onSelect={select}
            onAction={act}
            onMove={move}
            disabled={disabledReason}
            khmer={view.flags.khmer_ui_hints}
            review={review}
          />
        </PanelFrame>
      </div>
      <div className="flex gap-4 border-t bg-white px-3 py-1 text-[11px] text-slate-500">
        <span>
          <kbd>J</kbd>/<kbd>K</kbd> move
        </span>
        <span>
          <kbd>Enter</kbd> confirm, or type a hidden value
        </span>
        <span>
          <kbd>E</kbd> correct
        </span>
        <span>
          <kbd>F</kbd> flag
        </span>
        <span>
          <kbd>Ctrl</kbd>+<kbd>Enter</kbd> approve once every claim is decided
        </span>
        <span className="ml-auto">{online ? "" : "Offline: decisions are kept on this device and saved when you reconnect"}</span>
      </div>

      {result && <ResultModal result={result} content={view.draft.content} onClose={() => setResult(null)} onNext={() => nav("/")} />}
      {rejecting !== null && (
        <Modal title="Reject and redraft" onClose={() => setRejecting(null)}>
          <p className="text-slate-600">The draft goes back to the AI pipeline with your note. It is not patched by hand.</p>
          <textarea autoFocus className="mt-2 h-24 w-full rounded border p-2" value={rejecting} onChange={(e) => setRejecting(e.target.value)} placeholder="What needs to change?" />
          <div className="mt-2 flex justify-end gap-2">
            <button className="px-3 py-1" onClick={() => setRejecting(null)}>
              Cancel
            </button>
            <button
              className="rounded bg-slate-800 px-3 py-1 text-white disabled:opacity-40"
              disabled={!rejecting.trim()}
              onClick={async () => {
                try {
                  await api(`/api/tasks/${id}/reject`, { method: "POST", json: { note: rejecting } });
                  toast("Sent back for redraft.");
                  nav("/");
                } catch (e) {
                  toast(e instanceof Error ? e.message : String(e), "bad");
                }
              }}
            >
              Reject
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PanelFrame({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <section className="flex min-h-0 flex-col overflow-hidden rounded-md border border-slate-200 bg-white">
      <header className="flex items-baseline gap-2 border-b px-3 py-1.5">
        <h2 className="font-semibold">{title}</h2>
        <span className="truncate text-[11px] text-slate-500">{sub}</span>
      </header>
      <div className="min-h-0 flex-1">{children}</div>
    </section>
  );
}

export function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40" role="dialog" aria-modal>
      <div className="max-h-[85vh] w-[560px] overflow-auto rounded-lg bg-white p-4 shadow-xl">
        <h2 className="mb-2 text-base font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  );
}

function ResultModal({ result, content, onClose, onNext }: { result: ApproveResult; content: DraftContent; onClose: () => void; onNext: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => ref.current?.focus(), []);
  if (result.outcome === "released")
    return (
      <Modal title="Released" onClose={onNext}>
        <p className="text-slate-600" data-testid="released-message">
          Phase 0: the final output was written to the database. Nothing was sent or posted anywhere.
        </p>
        <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-[12px]" data-testid="released-output">
          {content.kind === "reply"
            ? `To: ${content.reply.to.join(", ")}\nSubject: ${content.reply.subject}\n\n${content.reply.body}`
            : Object.entries(content.bill)
                .filter(([, v]) => v != null)
                .map(([k, v]) => `${k}: ${k.endsWith("date") && v ? formatDate(v) : k === "total_amount" && v ? showValue({ type: "amount", field: k }, v, content) : v}`)
                .join("\n")}
        </pre>
        <div className="mt-3 flex justify-end">
          <button ref={ref} className="rounded bg-slate-800 px-3 py-1 text-white" onClick={onNext}>
            Next item <kbd>Enter</kbd>
          </button>
        </div>
      </Modal>
    );
  if (result.outcome === "held")
    return (
      <Modal title="Held: a seeded test error was missed" onClose={onClose}>
        <p data-testid="held-message">
          <b>{result.missed.label}</b> showed <code className="rounded bg-red-50 px-1">{result.missed.shown}</code>, but the source says{" "}
          <code className="rounded bg-emerald-50 px-1">{result.missed.actual}</code>.
        </p>
        <p className="mt-2 text-slate-600">The true draft is back. Check that claim again, then approve. Catch rate is for coaching, not discipline.</p>
        <div className="mt-3 flex justify-end">
          <button ref={ref} className="rounded bg-slate-800 px-3 py-1 text-white" onClick={onClose}>
            Back to the item
          </button>
        </div>
      </Modal>
    );
  if (result.outcome === "blocked")
    return (
      <Modal title="Not ready to approve" onClose={onClose}>
        <ul className="list-disc pl-5" data-testid="blocked-reasons">
          {result.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        <div className="mt-3 flex justify-end">
          <button ref={ref} className="rounded bg-slate-800 px-3 py-1 text-white" onClick={onClose}>
            OK
          </button>
        </div>
      </Modal>
    );
  return null;
}
