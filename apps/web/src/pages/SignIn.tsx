import { useEffect, useState } from "react";
import { api, setDevUser } from "../lib/api";

type DevUser = { email: string; name: string; role: string };

export function SignInPage({ error, onSignedIn }: { error: string | null; onSignedIn: () => void }) {
  const [users, setUsers] = useState<DevUser[] | null>(null);
  const [devAvailable, setDevAvailable] = useState(true);
  const [seedMsg, setSeedMsg] = useState<string | null>(null);

  const loadUsers = () =>
    api<DevUser[]>("/api/dev/users")
      .then(setUsers)
      .catch(() => setDevAvailable(false));
  useEffect(() => {
    void loadUsers();
  }, []);

  return (
    <div className="mx-auto mt-24 max-w-md rounded-lg bg-white p-6 shadow">
      <h1 className="text-lg font-semibold">Verification Console</h1>
      <p className="mt-1 text-slate-600">Sign in with your mesquaredagency.com Google account through Cloudflare Access.</p>
      {error && <p className="mt-3 rounded bg-red-50 p-2 text-red-700">{error}</p>}
      {devAvailable && (
        <div className="mt-6 border-t pt-4">
          <h2 className="font-medium">Local development sign-in</h2>
          <p className="text-slate-500">DEV_AUTH is on. Pick a demo user.</p>
          {users && users.length === 0 && (
            <button
              className="mt-3 rounded bg-slate-800 px-3 py-1.5 text-white"
              onClick={async () => {
                await api("/api/dev/seed", { method: "POST" });
                setSeedMsg("Demo data loaded.");
                await loadUsers();
              }}
            >
              Load demo data
            </button>
          )}
          {seedMsg && <p className="mt-2 text-emerald-700">{seedMsg}</p>}
          <ul className="mt-3 divide-y rounded border">
            {users?.map((u) => (
              <li key={u.email}>
                <button
                  className="flex w-full justify-between px-3 py-2 text-left hover:bg-slate-50"
                  onClick={() => {
                    setDevUser(u.email);
                    onSignedIn();
                  }}
                >
                  <span>{u.name}</span>
                  <span className="text-slate-500">{u.role}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
