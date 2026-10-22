import type { TaskSummary } from "@vc/shared";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";

export function ReviewPage() {
  const nav = useNavigate();
  const [next, setNext] = useState<TaskSummary | null | undefined>(undefined);
  useEffect(() => {
    const load = () => void api<{ task: TaskSummary | null }>("/api/review/next").then((r) => setNext(r.task));
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="mx-auto max-w-3xl p-6">
      <h1 className="mb-3 text-lg font-semibold">Second review</h1>
      {next ? (
        <div className="rounded-lg border bg-white p-4 shadow-sm">
          <div className="text-[12px] text-slate-500">
            {next.client_name} · Tier {next.tier}
          </div>
          <div className="mt-1 text-base font-medium">{next.title}</div>
          <button autoFocus className="mt-3 rounded bg-slate-900 px-4 py-1.5 text-white" onClick={() => nav(`/tasks/${next.id}`)}>
            Review <kbd>Enter</kbd>
          </button>
        </div>
      ) : next === null ? (
        <div className="rounded-lg border border-dashed bg-white p-4 text-slate-500">Nothing waiting for second review.</div>
      ) : null}
    </div>
  );
}
