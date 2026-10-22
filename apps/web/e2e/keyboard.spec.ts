// Acceptance: the full keyboard flow works on Chrome at 1366×768, with no mouse.
import { expect, test } from "@playwright/test";
import { addEmail, seed, signIn, task, waitQueued } from "./helpers";

test("verify and approve a tenant email using only the keyboard", async ({ page, request }) => {
  await seed(request);
  const id = await addEmail(request, "E02");
  await waitQueued(request, id);
  await signIn(page);
  await page.goto("/");

  // Queue: the next item only, started with Enter.
  await expect(page.getByTestId("next-item")).toBeVisible();
  await expect(page.getByTestId("start")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/tasks/${id}`));
  await expect(page.getByTestId("claim-row").first()).toBeVisible();

  // Nothing scrolls sideways at 1366×768.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1366);

  // J/K move the selection.
  const active = page.locator("[data-testid=claim-row][data-active=true]");
  const firstId = await active.getAttribute("data-claim-id");
  await page.keyboard.press("j");
  expect(await active.getAttribute("data-claim-id")).not.toBe(firstId);
  await page.keyboard.press("k");
  expect(await active.getAttribute("data-claim-id")).toBe(firstId);

  // Work down the claims list until nothing is open.
  for (let step = 0; step < 40; step++) {
    const open = await page.locator("[data-testid=claim-row][data-status=undecided]").count();
    if (open === 0) break;
    const row = page.locator("[data-testid=claim-row][data-active=true]");
    const status = await row.getAttribute("data-status");
    if (status !== "undecided") {
      await page.keyboard.press("j");
      continue;
    }
    const group = await row.getAttribute("data-group");
    if ((await row.getAttribute("data-rekey")) === "pending") {
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("rekey-input")).toBeFocused();
      await page.keyboard.type("$720.00"); // Daniel's rent, read from the tenancy record shown in the source panel
      await page.keyboard.press("Enter");
    } else if (group === "unsupported" || group === "omitted") {
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("note-input")).toBeFocused();
      await page.keyboard.type("Checked with the playbook; OK for this reply");
      await page.keyboard.press("Enter");
    } else {
      await page.keyboard.press("Enter");
    }
    await page.waitForTimeout(150);
  }
  await expect(page.getByTestId("sync-status")).toHaveText("Saved", { timeout: 15_000 });
  await expect(page.getByTestId("approve")).toBeEnabled();

  // Ctrl+Enter approves; the console performs the release (to the database in Phase 0).
  await page.keyboard.press("Control+Enter");
  await expect(page.getByTestId("released-message")).toBeVisible();
  await expect(page.getByTestId("released-output")).toContainText("To: daniel.okafor@example.com");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/$/);
  expect((await task(request, id)).status).toBe("released");
});

test("flagging and correcting by keyboard", async ({ page, request }) => {
  await seed(request);
  const id = await addEmail(request, "E01");
  await waitQueued(request, id);
  await signIn(page);
  await page.goto(`/tasks/${id}`);
  await expect(page.getByTestId("claim-row").first()).toBeVisible();

  // F opens a note for the senior reviewer.
  await page.keyboard.press("f");
  await expect(page.getByTestId("flag-input")).toBeFocused();
  await page.keyboard.type("Not sure this is the right tenant");
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-testid=claim-row][data-status=flagged]")).toHaveCount(1, { timeout: 10_000 });

  // E opens a correction on the greeting name.
  const name = page.locator("[data-testid=claim-row]").filter({ hasText: "Name" }).first();
  await name.click();
  await page.keyboard.press("e");
  await expect(page.getByTestId("correct-input")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("correct-input")).toHaveCount(0);
});
