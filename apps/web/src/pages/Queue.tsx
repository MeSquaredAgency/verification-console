// The queue shows the next item only, never the backlog.
import type { TaskSummary } from "@vc/shared";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useToast } from "../components/Toast";
import { api } from "../lib/api";
import { useMe } from "../lib/useMe";
import { Modal } from "./Verify";

const TYPE_LABEL = { supplier_bill: "Supplier bill", tenant_email: "Tenant email" } as const;

export function QueuePage() {
  const me = useMe();
  const nav = useNavigate();
  const [next, setNext] = useState<{ task: TaskSummary | null; resume: boolean; processing?: number } | null>(null);
  const [pacing, setPacing] = useState<{ streak_minutes: number; break_due: boolean } | null>(null);
  const [onBreak, setOnBreak] = useState(false);
  const startRef = useRef<HTMLButtonElement>(null);

  const load = () => {
    void api<typeof next>("/api/queue/next").then(setNext);
    void api<typeof pacing>("/api/me/pacing").then(setPacing);
  };
  useEffect(() => {
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => startRef.current?.focus(), [next?.task?.id]);

  if (me.role === "auditor") return <div className="p-6 text-slate-600">Auditors have read-only access. Use Audit and Metrics.</div>;

  return (
    <div className="mx-auto max-w-3xl p-6">
      {pacing?.break_due && !onBreak && (
        <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-3" data-testid="break-prompt">
          <b>Time for a break.</b> You've been verifying for {pacing.streak_minutes} minutes without one. A short break keeps the 40th item as careful as the first.
          <button className="ml-3 rounded bg-amber-700 px-2 py-0.5 text-white" onClick={async () => { await api("/api/me/break", { method: "POST" }); setOnBreak(true); }}>
            Take a 10-minute break
          </button>
        </div>
      )}
      {onBreak && (
        <Modal title="On a break" onClose={() => setOnBreak(false)}>
          <p>The queue will be here when you're back.</p>
          <button className="mt-3 rounded bg-slate-800 px-3 py-1 text-white" onClick={() => { setOnBreak(false); load(); }}>
            I'm back
          </button>
        </Modal>
      )}
      <h1 className="mb-3 text-lg font-semibold">Next item</h1>
      {next?.task ? (
        <div className="rounded-lg border bg-white p-4 shadow-sm" data-testid="next-item">
          <div className="text-[12px] text-slate-500">
            {next.task.client_name} · {TYPE_LABEL[next.task.type]} · Tier {next.task.tier}
          </div>
          <div className="mt-1 text-base font-medium">{next.task.title}</div>
          <button
            ref={startRef}
            className="mt-3 rounded bg-slate-900 px-4 py-1.5 text-white"
            onClick={() => nav(`/tasks/${next.task!.id}`)}
            data-testid="start"
          >
            {next.resume ? "Resume" : "Start"} <kbd>Enter</kbd>
          </button>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed bg-white p-4 text-slate-500" data-testid="queue-empty">
          Nothing waiting.{next?.processing ? ` ${next.processing} item${next.processing === 1 ? " is" : "s are"} still being prepared by the AI pipeline.` : ""}
        </div>
      )}
      <AddWork />
    </div>
  );
}

function AddWork() {
  const me = useMe();
  const toast = useToast();
  const [tab, setTab] = useState<"pdf" | "email">("pdf");
  const [clientId, setClientId] = useState(me.clients[0]?.id ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  if (!me.clients.length) return null;

  const submit = async () => {
    setBusy(true);
    try {
      if (tab === "pdf") {
        if (!file) return;
        const form = new FormData();
        form.set("client_id", clientId);
        form.set("file", file);
        await api("/api/tasks", { method: "POST", body: form });
        setFile(null);
      } else {
        await api("/api/tasks", { method: "POST", json: { client_id: clientId, email } });
        setEmail("");
      }
      toast("Added. The AI pipeline is preparing it.", "good");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="mt-8 rounded-lg border bg-white p-4" data-testid="add-work">
      <summary className="cursor-pointer font-medium">Add work (Phase 0: upload a PDF bill or paste an email)</summary>
      <div className="mt-3 flex items-center gap-3">
        <label className="text-slate-600">
          Client{" "}
          <select className="rounded border px-1 py-0.5" value={clientId} onChange={(e) => setClientId(e.target.value)}>
            {me.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <div className="ml-auto flex rounded border text-[12px]">
          <button className={`px-2 py-0.5 ${tab === "pdf" ? "bg-slate-800 text-white" : ""}`} onClick={() => setTab("pdf")}>
            Supplier bill PDF
          </button>
          <button className={`px-2 py-0.5 ${tab === "email" ? "bg-slate-800 text-white" : ""}`} onClick={() => setTab("email")}>
            Tenant or landlord email
          </button>
        </div>
      </div>
      {tab === "pdf" ? (
        <input className="mt-3 block" type="file" accept="application/pdf" data-testid="pdf-input" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      ) : (
        <textarea
          className="mt-3 h-48 w-full rounded border p-2 font-mono text-[12px]"
          placeholder={"From: Name <email@example.com>\nSubject: ...\n\nBody"}
          value={email}
          data-testid="email-input"
          onChange={(e) => setEmail(e.target.value)}
        />
      )}
      <button className="mt-2 rounded bg-slate-800 px-3 py-1 text-white disabled:opacity-40" disabled={busy || (tab === "pdf" ? !file : !email.trim())} onClick={submit} data-testid="add-submit">
        {busy ? "Adding…" : "Add to queue"}
      </button>
    </details>
  );
}
