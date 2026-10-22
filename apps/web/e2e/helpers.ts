import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.resolve(here, "../../../fixtures");
export const OP = "sophea@mesquaredagency.com";

export async function seed(request: APIRequestContext) {
  await request.post("/api/dev/seed");
}

export async function addEmail(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.post("/api/tasks", {
    headers: { "X-Dev-User": OP },
    data: { client_id: "apn-demo", email: readFileSync(path.join(FIXTURES, "emails", `${id}.txt`), "utf8") },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

export async function addBill(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.post("/api/tasks", {
    headers: { "X-Dev-User": OP },
    multipart: { client_id: "apn-demo", file: { name: `${id}.pdf`, mimeType: "application/pdf", buffer: readFileSync(path.join(FIXTURES, "bills", `${id}.pdf`)) } },
  });
  expect(res.status()).toBe(201);
  return (await res.json()).id;
}

/** Wait for the pipeline (local queue) to finish preparing a task. */
export async function waitQueued(request: APIRequestContext, id: string) {
  await expect
    .poll(async () => (await (await request.get(`/api/tasks/${id}`, { headers: { "X-Dev-User": OP } })).json()).status, { timeout: 60_000, intervals: [500] })
    .toBe("queued");
}

export async function signIn(page: Page, email = OP) {
  await page.goto("/");
  await page.evaluate((e) => localStorage.setItem("vc.devUser", e), email);
}

export async function task(request: APIRequestContext, id: string) {
  return (await request.get(`/api/tasks/${id}`, { headers: { "X-Dev-User": OP } })).json();
}
