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
      <Users clients={clients} readOnly={ro} />
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

type UserRow = { email: string; name: string; role: string; licensed_apn: number; active: number; clients: string | null };

function Users({ clients, readOnly }: { clients: Client[]; readOnly: boolean }) {
  const toast = useToast();
  const [users, setUsers] = useState<UserRow[]>([]);
  const [form, setForm] = useState({ email: "", name: "", role: "operator", licensed_apn: false, clients: [] as string[], active: true });
  const load = () => void api<UserRow[]>("/api/admin/users").then(setUsers);
  useEffect(load, []);
  const save = async () => {
    try {
      await api("/api/admin/users", { method: "POST", json: form });
      toast(`Saved ${form.email}`, "good");
      setForm({ email: "", name: "", role: "operator", licensed_apn: false, clients: [], active: true });
      load();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "bad");
    }
  };
  return (
    <section className="mb-6 rounded-lg border bg-white p-4">
      <h1 className="text-lg font-semibold">Users</h1>
      <p className="text-[12px] text-slate-500">People also need to pass Cloudflare Access with their mesquaredagency.com Google account. Operators only see clients they're assigned to.</p>
      <table className="mt-2 w-full text-left">
        <thead className="text-[12px] text-slate-500">
          <tr>
            <th className="py-1">Email</th>
            <th>Name</th>
            <th>Role</th>
            <th>Licensed APN</th>
            <th>Clients</th>
            <th>Active</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => (
            <tr key={u.email} className="cursor-pointer border-t hover:bg-slate-50" onClick={() => !readOnly && setForm({ email: u.email, name: u.name, role: u.role, licensed_apn: !!u.licensed_apn, clients: u.clients ? u.clients.split(",") : [], active: !!u.active })}>
              <td className="py-1">{u.email}</td>
              <td>{u.name}</td>
              <td>{u.role}</td>
              <td>{u.licensed_apn ? "yes" : ""}</td>
              <td>{u.clients}</td>
              <td>{u.active ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!readOnly && (
        <div className="mt-3 grid grid-cols-[1fr_1fr_auto] gap-2 border-t pt-3">
          <input className="rounded border px-2 py-0.5" placeholder="name@mesquaredagency.com" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <input className="rounded border px-2 py-0.5" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <select className="rounded border px-1" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            {["operator", "senior", "admin", "auditor"].map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
          <div className="col-span-3 flex flex-wrap items-center gap-4">
            <label>
              <input type="checkbox" checked={form.licensed_apn} onChange={(e) => setForm({ ...form, licensed_apn: e.target.checked })} /> Licensed APN person
            </label>
            <label>
              <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active
            </label>
            {clients.map((c) => (
              <label key={c.id}>
                <input
                  type="checkbox"
                  checked={form.clients.includes(c.id)}
                  onChange={(e) => setForm({ ...form, clients: e.target.checked ? [...form.clients, c.id] : form.clients.filter((x) => x !== c.id) })}
                />{" "}
                {c.name}
              </label>
            ))}
            <button className="ml-auto rounded bg-slate-800 px-3 py-1 text-white disabled:opacity-40" disabled={!form.email || !form.name} onClick={save}>
              Save user
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
