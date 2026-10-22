// Fetch wrapper. In production Cloudflare Access signs the user in (cookie); locally the dev
// user picker sets X-Dev-User.

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Thrown when the request never reached the server (offline, dropped connection). */
export class NetworkError extends Error {}

export function devUser(): string | null {
  try {
    return localStorage.getItem("vc.devUser");
  } catch {
    return null;
  }
}

export function setDevUser(email: string | null) {
  try {
    if (email) localStorage.setItem("vc.devUser", email);
    else localStorage.removeItem("vc.devUser");
  } catch {
    /* storage unavailable */
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const u = devUser();
  if (u) headers.set("X-Dev-User", u);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers, body, credentials: "same-origin" });
  } catch {
    throw new NetworkError("No connection");
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

export async function apiBytes(path: string): Promise<Uint8Array> {
  const headers = new Headers();
  const u = devUser();
  if (u) headers.set("X-Dev-User", u);
  const res = await fetch(path, { headers, credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, "Could not load the source");
  return new Uint8Array(await res.arrayBuffer());
}
