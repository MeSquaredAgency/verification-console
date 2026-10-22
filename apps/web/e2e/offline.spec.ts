// Acceptance: pulling the network mid-task loses no decisions.
import { expect, test } from "@playwright/test";
import { addBill, OP, seed, signIn, task, waitQueued } from "./helpers";

test("decisions made offline are kept and saved on reconnect, even after closing the tab", async ({ page, context, request }) => {
  await seed(request);
  const id = await addBill(request, "B01");
  await waitQueued(request, id);
  await signIn(page);
  await page.goto(`/tasks/${id}`);
  await expect(page.getByTestId("claim-row").first()).toBeVisible();

  // Go to the Matched group and confirm one claim while online.
  const matched = page.locator("[data-testid=claim-row][data-group=matched]");
  await matched.first().click();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("sync-status")).toHaveText("Saved", { timeout: 10_000 });

  // Pull the network, keep working.
  await context.setOffline(true);
  const decidedOffline: string[] = [];
  for (let i = 0; i < 4; i++) {
    const row = page.locator("[data-testid=claim-row][data-active=true]");
    decidedOffline.push((await row.getAttribute("data-claim-id"))!);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(100);
  }
  await expect(page.getByTestId("sync-status")).toContainText("4 decisions waiting to save");
  await expect(page.locator("[data-testid=claim-row][data-status=saving]")).toHaveCount(4);

  // Close the tab while still offline, reconnect, and come back.
  await page.close();
  await context.setOffline(false);
  const again = await context.newPage();
  await again.goto(`/tasks/${id}`);
  await expect(again.getByTestId("sync-status")).toHaveText("Saved", { timeout: 15_000 });

  const view = await task(request, id);
  for (const cid of decidedOffline) {
    const c = view.claims.find((x: { id: string }) => x.id === cid);
    expect(c?.status, cid).toBe("confirmed");
  }
  const audit = await (await request.get(`/api/tasks/${id}/audit`, { headers: { "X-Dev-User": "lead@mesquaredagency.com" } })).json();
  expect(audit.filter((e: { event: string; actor: string }) => e.event === "decision" && e.actor === OP)).toHaveLength(5);
});
