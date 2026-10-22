import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Q = { group: string; n?: number; median?: number; p25?: number; p75?: number };
type Metrics = {
  draft_error_rate: { client_id: string; type: string; corrected: number; checked: number }[];
  seeded_catch_rate: { operator: string; week: string; caught: number; missed: number }[];
  escaped_errors: { escaped: number; open: number | null };
  time_per_claim_ms: Q[];
  time_per_item_ms: Q[];
  flags_and_escalations: { note: string; n: number }[];
  unsupported_and_omitted: { drafts: number; unsupported: number | null; omitted: number | null };
};

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "n/a");
const secs = (ms?: number) => (ms == null ? "n/a" : `${(ms / 1000).toFixed(1)}s`);

export function MetricsPage() {
  const [m, setM] = useState<Metrics | null>(null);
  useEffect(() => {
    void api<Metrics>("/api/metrics").then(setM);
  }, []);
  if (!m) return <div className="p-6 text-slate-500">Loading…</div>;
  const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <section className="rounded-lg border bg-white p-4">
      <h2 className="mb-2 font-semibold">{title}</h2>
      {children}
    </section>
  );
  return (
    <div className="mx-auto grid max-w-5xl gap-4 p-6 md:grid-cols-2">
      <Card title="Draft error rate (claims corrected ÷ claims checked)">
        {m.draft_error_rate.map((r) => (
          <div key={r.client_id + r.type}>
            {r.client_id} · {r.type}: <b>{pct(r.corrected, r.checked)}</b> ({r.corrected}/{r.checked})
          </div>
        ))}
        {!m.draft_error_rate.length && <p className="text-slate-500">No releases yet.</p>}
      </Card>
      <Card title="Seeded-error catch rate (coaching, not discipline)">
        {m.seeded_catch_rate.map((r) => (
          <div key={r.operator + r.week}>
            {r.week} · {r.operator}: <b>{pct(r.caught, r.caught + r.missed)}</b> ({r.caught}/{r.caught + r.missed})
          </div>
        ))}
        {!m.seeded_catch_rate.length && <p className="text-slate-500">No seeded errors resolved yet.</p>}
      </Card>
      <Card title="Escaped errors">
        <b>{m.escaped_errors.escaped}</b> reported after release ({m.escaped_errors.open ?? 0} open)
      </Card>
      <Card title="Unsupported and omitted findings">
        {m.unsupported_and_omitted.drafts ? (
          <>
            {((m.unsupported_and_omitted.unsupported ?? 0) / m.unsupported_and_omitted.drafts).toFixed(2)} unsupported and {((m.unsupported_and_omitted.omitted ?? 0) / m.unsupported_and_omitted.drafts).toFixed(2)} omitted per released draft
          </>
        ) : (
          <p className="text-slate-500">No releases yet.</p>
        )}
      </Card>
      <Card title="Time per claim (median, IQR)">
        {m.time_per_claim_ms.map((q) => (
          <div key={q.group}>
            {q.group}: <b>{secs(q.median)}</b> ({secs(q.p25)} to {secs(q.p75)}, n={q.n})
          </div>
        ))}
      </Card>
      <Card title="Time per item (median, IQR)">
        {m.time_per_item_ms.map((q) => (
          <div key={q.group}>
            {q.group}: <b>{secs(q.median)}</b> ({secs(q.p25)} to {secs(q.p75)}, n={q.n})
          </div>
        ))}
      </Card>
      <Card title="Flags and escalations">
        {m.flags_and_escalations.map((f, i) => (
          <div key={i}>
            {f.n} × {f.note}
          </div>
        ))}
      </Card>
    </div>
  );
}
