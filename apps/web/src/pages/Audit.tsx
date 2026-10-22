// Audit: any task, its append-only event log, and for releases the rebuilt claim-by-claim trail.
import type { TaskSummary } from "@vc/shared";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useToast } from "../components/Toast";
import { api } from "../lib/api";
import { useMe } from "../lib/useMe";

export function AuditPage() {
  const [status, setStatus] = useState("");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  useEffect(() => {
    void api<TaskSummary[]>(`/api/tasks${status ? `?status=${status}` : ""}`).then(setTasks);
  }, [status]);
  return (
    <div className="mx-auto max-w-5xl p-6">
      <div className="mb-3 flex items-center gap-3">
        <h1 className="text-lg font-semibold">Tasks</h1>
        <select className="rounded border px-1 py-0.5" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">All</option>
          {["processing", "queued", "in_review", "second_review", "released", "error"].map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </div>
      <table className="w-full rounded border bg-white text-left">
        <thead className="bg-slate-50 text-[12px] text-slate-500">
          <tr>
            <th className="p-2">Created</th>
            <th className="p-2">Client</th>
            <th className="p-2">Item</th>
            <th className="p-2">Tier</th>
            <th className="p-2">Status</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => (
            <tr key={t.id} className="border-t">
              <td className="p-2 text-slate-500">{new Date(t.created_at).toLocaleString("en-AU")}</td>
              <td className="p-2">{t.client_name}</td>
              <td className="p-2">
                <Link className="text-accent underline" to={`/audit/${t.id}`}>
                  {t.title}
                </Link>
              </td>
              <td className="p-2">{t.tier}</td>
              <td className="p-2">{t.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type Event = { id: number; ts: string; actor: string; event: string; detail: Record<string, unknown> };
type Report = {
  release: { id: string; approved_by: string; second_reviewer: string | null; created_at: string; output_hash: string };
  claims: {
    label: string;
    value: string;
    status: string;
    source_span: { page: number; text: string } | null;
    decisions: { actor: string; role: string; action: string; value: string | null; note: string | null; outcome: string | null; created_at: string; time_ms: number | null }[];
  }[];
};

export function TaskAuditPage() {
  const { id } = useParams();
  const me = useMe();
  const toast = useToast();
  const [events, setEvents] = useState<Event[]>([]);
  const [view, setView] = useState<{ title: string; release: { id: string } | null } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [incident, setIncident] = useState("");

  useEffect(() => {
    void api<Event[]>(`/api/tasks/${id}/audit`).then(setEvents);
    void api<{ title: string; release: { id: string } | null }>(`/api/tasks/${id}`).then((v) => {
      setView(v);
      if (v.release) void api<Report>(`/api/releases/${v.release.id}/audit-report`).then(setReport);
    });
  }, [id]);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <h1 className="text-lg font-semibold">{view?.title}</h1>
      <p className="mb-4 text-slate-500">
        <Link className="underline" to={`/tasks/${id}`}>
          Open the verification screen (read-only)
        </Link>
      </p>
      {report && (
        <section className="mb-6">
          <h2 className="mb-2 font-semibold">Release audit trail</h2>
          <p className="mb-2 text-slate-600">
            Released {new Date(report.release.created_at).toLocaleString("en-AU")} · approved by {report.release.approved_by}
            {report.release.second_reviewer ? ` · second review by ${report.release.second_reviewer}` : ""} · output hash <code>{report.release.output_hash.slice(0, 12)}…</code>
          </p>
          <table className="w-full rounded border bg-white text-left" data-testid="audit-report">
            <thead className="bg-slate-50 text-[12px] text-slate-500">
              <tr>
                <th className="p-2">Claim</th>
                <th className="p-2">Released value</th>
                <th className="p-2">Source span</th>
                <th className="p-2">Decisions (who, what, when, time taken)</th>
              </tr>
            </thead>
            <tbody>
              {report.claims.map((c, i) => (
                <tr key={i} className="border-t align-top">
                  <td className="p-2">{c.label}</td>
                  <td className="p-2 font-medium">{c.value}</td>
                  <td className="p-2 text-slate-600">{c.source_span ? `p${c.source_span.page}: "${c.source_span.text}"` : "(none)"}</td>
                  <td className="p-2">
                    {c.decisions.map((d, j) => (
                      <div key={j}>
                        {d.actor} ({d.role}) · {d.action}
                        {d.value ? ` "${d.value}"` : ""}
                        {d.note ? ` · note: ${d.note}` : ""}
                        {d.outcome && d.outcome !== d.action ? ` · ${d.outcome}` : ""} · {new Date(d.created_at).toLocaleString("en-AU")}
                        {d.time_ms != null ? ` · ${(d.time_ms / 1000).toFixed(1)}s` : ""}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {me.role !== "operator" && (
            <div className="mt-3 rounded border bg-white p-3">
              <h3 className="font-medium">Report an escaped error</h3>
              <textarea className="mt-2 h-20 w-full rounded border p-2" value={incident} onChange={(e) => setIncident(e.target.value)} placeholder="What the client reported" />
              <button
                className="mt-1 rounded bg-slate-800 px-3 py-1 text-white disabled:opacity-40"
                disabled={!incident.trim()}
                onClick={async () => {
                  await api(`/api/releases/${report.release.id}/incidents`, { method: "POST", json: { report: incident } });
                  setIncident("");
                  toast("Incident logged. Next: assign one root cause and fix at that layer.", "good");
                }}
              >
                Log incident
              </button>
            </div>
          )}
        </section>
      )}
      <h2 className="mb-2 font-semibold">Event log (append-only)</h2>
      <table className="w-full rounded border bg-white text-left text-[12px]">
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-t align-top">
              <td className="whitespace-nowrap p-1.5 text-slate-500">{new Date(e.ts).toLocaleString("en-AU")}</td>
              <td className="p-1.5">{e.actor}</td>
              <td className="p-1.5 font-medium">{e.event}</td>
              <td className="p-1.5 font-mono text-slate-600">{JSON.stringify(e.detail)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
