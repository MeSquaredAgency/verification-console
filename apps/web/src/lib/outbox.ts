// Decisions are saved as they are made. Each is written to localStorage first, then sent; if
// the connection drops they stay queued and are re-sent (the server ignores duplicate ids).
import type { DecisionAction, TaskView } from "@vc/shared";
import { api, ApiError, NetworkError } from "./api";

export type PendingDecision = {
  id: string;
  taskId: string;
  claim_id: string;
  action: DecisionAction;
  value?: string | null;
  note?: string | null;
  time_ms?: number | null;
  queued_at: string;
};

export type SyncEvent =
  | { kind: "synced"; decision: PendingDecision; task: TaskView; outcome: string; canary: "caught" | null }
  | { kind: "rejected"; decision: PendingDecision; message: string }
  | { kind: "offline" }
  | { kind: "changed" };

const KEY = "vc.outbox";

function load(): PendingDecision[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

function save(items: PendingDecision[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* storage full or unavailable: the in-memory copy still syncs */
  }
}

let memory: PendingDecision[] = load();
const listeners = new Set<(e: SyncEvent) => void>();
let syncing = false;

export function pending(taskId?: string): PendingDecision[] {
  return taskId ? memory.filter((d) => d.taskId === taskId) : memory;
}

export function subscribe(fn: (e: SyncEvent) => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(e: SyncEvent) {
  for (const l of listeners) l(e);
}

export function enqueue(d: Omit<PendingDecision, "id" | "queued_at">) {
  const item: PendingDecision = { ...d, id: crypto.randomUUID(), queued_at: new Date().toISOString() };
  memory = [...memory, item];
  save(memory);
  emit({ kind: "changed" });
  void flush();
  return item;
}

/** Send queued decisions in order. Stops at the first network failure and retries later. */
export async function flush() {
  if (syncing) return;
  syncing = true;
  try {
    while (memory.length) {
      const d = memory[0];
      try {
        const res = await api<{ outcome: string; canary: "caught" | null; task: TaskView }>(`/api/tasks/${d.taskId}/decisions`, {
          method: "POST",
          json: { id: d.id, claim_id: d.claim_id, action: d.action, value: d.value ?? null, note: d.note ?? null, time_ms: d.time_ms ?? null },
        });
        memory = memory.slice(1);
        save(memory);
        emit({ kind: "synced", decision: d, task: res.task, outcome: res.outcome, canary: res.canary });
      } catch (err) {
        if (err instanceof NetworkError) {
          emit({ kind: "offline" });
          return;
        }
        // The server refused it (e.g. the claim was replaced). Drop it and tell the operator.
        memory = memory.slice(1);
        save(memory);
        emit({ kind: "rejected", decision: d, message: err instanceof ApiError ? err.message : String(err) });
      }
    }
  } finally {
    syncing = false;
    emit({ kind: "changed" });
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("online", () => void flush());
  setInterval(() => {
    if (memory.length) void flush();
  }, 3000);
}
