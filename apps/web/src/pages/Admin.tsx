// Settings: thresholds, seeded-error rate, spot-check floor and feature flags.
import { useEffect, useState } from "react";
import { useToast } from "../components/Toast";
import { api } from "../lib/api";
import { formatCents } from "@vc/shared";
import { useMe } from "../lib/useMe";

type Client = {
  id: string;
  name: string;
  tier3_threshold_cents: number;
  seeded_rate: number;
  retention_days: number;
  spot_check_floor_ms: number | null;
  flags: Record<string, boolean>;
  phase_gated: Record<string, string>;
};

export function AdminPage() {
  const me = useMe();
  const toast = useToast();
  const [clients, setClients] = useState<Client[]>([]);
  const load = () => void api<Client[]>("/api/admin/clients").then(setClients);
  useEffect(load, []);
  const ro = me.role !== "admin";
  const patch = async (id: string, body: unknown) => {
    try {
      await api(`/api/admin/clients/${id}`, { method: "PATCH", json: body });
      toast("Saved", "good");
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
  };
  return (
    <div className="mx-auto max-w-4xl p-6">
      <h1 className="mb-3 text-lg font-semibold">Client settings</h1>
      {clients.map((c) => (
        <section key={c.id} className="mb-6 rounded-lg border bg-white p-4">
          <h2 className="font-semibold">{c.name}</h2>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <Field label={`Tier 3 threshold (now ${formatCents(c.tier3_threshold_cents)})`} disabled={ro} placeholder="5000.00" onSave={(v) => patch(c.id, { tier3_threshold_cents: Math.round(Number(v) * 100) })} />
            <Field label={`Seeded errors: 1 in N items (now ${c.seeded_rate})`} disabled={ro} placeholder="20" onSave={(v) => patch(c.id, { seeded_rate: Number(v) })} />
            <Field label={`Source retention days (now ${c.retention_days})`} disabled={ro} placeholder="90" onSave={(v) => patch(c.id, { retention_days: Number(v) })} />
            <Field
              label={`Spot-check floor, ms per claim (now ${c.spot_check_floor_ms ?? "not calibrated"})`}
              disabled={ro}
              placeholder="calibrate from pilot data"
              onSave={(v) => patch(c.id, { spot_check_floor_ms: v ? Number(v) : null })}
            />
          </div>
          <h3 className="mt-4 font-medium">Feature flags</h3>
          <p className="text-[12px] text-slate-500">There is deliberately no flag for sampling or skipping verification on tier 1.</p>
          <ul className="mt-2 divide-y rounded border">
            {Object.entries(c.flags).map(([k, v]) => (
              <li key={k} className="flex items-center gap-3 px-3 py-1.5">
                <input type="checkbox" checked={v} disabled={ro || (!v && !!c.phase_gated[k])} onChange={(e) => patch(c.id, { flags: { [k]: e.target.checked } })} />
                <code>{k}</code>
                {c.phase_gated[k] && <span className="text-[12px] text-slate-500">Waits on: {c.phase_gated[k]}</span>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Field({ label, placeholder, disabled, onSave }: { label: string; placeholder: string; disabled: boolean; onSave: (v: string) => void }) {
  const [v, setV] = useState("");
  return (
    <label className="block">
      <span className="text-[12px] text-slate-600">{label}</span>
      <div className="mt-0.5 flex gap-1">
        <input className="w-full rounded border px-2 py-0.5" value={v} placeholder={placeholder} disabled={disabled} onChange={(e) => setV(e.target.value)} />
        <button className="rounded border px-2 disabled:opacity-40" disabled={disabled || v === ""} onClick={() => onSave(v)}>
          Save
        </button>
      </div>
    </label>
  );
}
