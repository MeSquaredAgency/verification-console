import type { Me } from "@vc/shared";
import { useEffect, useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate } from "react-router-dom";
import { ToastProvider } from "./components/Toast";
import { api, ApiError, devUser, setDevUser } from "./lib/api";
import { pending, subscribe } from "./lib/outbox";
import { MeContext } from "./lib/useMe";
import { AdminPage } from "./pages/Admin";
import { AuditPage, TaskAuditPage } from "./pages/Audit";
import { MetricsPage } from "./pages/Metrics";
import { QueuePage } from "./pages/Queue";
import { ReviewPage } from "./pages/Review";
import { SignInPage } from "./pages/SignIn";
import { VerifyPage } from "./pages/Verify";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api<Me>("/api/me")
      .then((m) => {
        setMe(m);
        setError(null);
      })
      .catch((e) => {
        setMe(null);
        setError(e instanceof ApiError && e.status === 401 ? null : String(e.message));
      })
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading) return <div className="p-8 text-slate-500">Loading…</div>;
  if (!me) return <SignInPage error={error} onSignedIn={load} />;
  return (
    <MeContext.Provider value={me}>
      <ToastProvider>
        <Shell me={me} onSignOut={() => { setDevUser(null); setMe(null); }}>
          <Routes>
            <Route path="/" element={<QueuePage />} />
            <Route path="/tasks/:id" element={<VerifyPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/audit/:id" element={<TaskAuditPage />} />
            <Route path="/metrics" element={<MetricsPage />} />
            <Route path="/admin" element={<AdminPage />} />
          </Routes>
        </Shell>
      </ToastProvider>
    </MeContext.Provider>
  );
}

function SyncStatus() {
  const [n, setN] = useState(pending().length);
  const [offline, setOffline] = useState(!navigator.onLine);
  useEffect(() => {
    const off = subscribe((e) => {
      setN(pending().length);
      if (e.kind === "offline") setOffline(true);
      if (e.kind === "synced") setOffline(false);
    });
    const on = () => setOffline(false);
    const down = () => setOffline(true);
    window.addEventListener("online", on);
    window.addEventListener("offline", down);
    return () => {
      off();
      window.removeEventListener("online", on);
      window.removeEventListener("offline", down);
    };
  }, []);
  if (!n && !offline) return <span className="text-emerald-700" data-testid="sync-status">Saved</span>;
  return (
    <span className={offline ? "text-amber-700" : "text-slate-600"} data-testid="sync-status">
      {offline ? "Offline · " : ""}
      {n ? `${n} decision${n === 1 ? "" : "s"} waiting to save` : "Reconnecting…"}
    </span>
  );
}

function Shell({ me, children, onSignOut }: { me: Me; children: React.ReactNode; onSignOut: () => void }) {
  const nav = useNavigate();
  const link = ({ isActive }: { isActive: boolean }) => `rounded px-2 py-1 ${isActive ? "bg-slate-700 text-white" : "text-slate-300 hover:text-white"}`;
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-10 shrink-0 items-center gap-3 bg-slate-900 px-3 text-slate-100">
        <Link to="/" className="font-semibold tracking-tight">
          Verification Console
        </Link>
        <nav className="flex gap-1 text-[12px]">
          {me.role !== "auditor" && <NavLink to="/" end className={link}>Queue</NavLink>}
          {(me.role === "senior" || me.role === "admin") && <NavLink to="/review" className={link}>Second review</NavLink>}
          {me.role !== "operator" && <NavLink to="/audit" className={link}>Audit</NavLink>}
          {me.role !== "operator" && <NavLink to="/metrics" className={link}>Metrics</NavLink>}
          {(me.role === "admin" || me.role === "auditor") && <NavLink to="/admin" className={link}>Settings</NavLink>}
        </nav>
        <div className="ml-auto flex items-center gap-3 text-[12px]">
          <SyncStatus />
          <span className="text-slate-400">
            {me.name} · {me.role}
          </span>
          {devUser() && (
            <button className="text-slate-400 underline" onClick={() => { onSignOut(); nav("/"); }}>
              Switch user
            </button>
          )}
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
    </div>
  );
}
