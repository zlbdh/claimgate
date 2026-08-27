import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  createPublishedStagedClaim,
  executeTool,
  installFaithfulModelContext,
  startPublicDemo,
  submitCorrectEvidence,
  toolNames,
} from "./claim-gate-harness";

test.use({ trace: "off" });

test("the complete claim handoff stays on visible navigation after the first claim", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  const source = readFileSync("tests/e2e/role-resume-navigation.spec.ts", "utf8");
  const directNavigationCall = new RegExp(["page", "goto\\s*\\("].join("\\."));
  expect(source, "this acceptance spec must never call direct page navigation")
    .not.toMatch(directNavigationCall);

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installFaithfulModelContext(context);
  await startPublicDemo(page);
  const staged = await createPublishedStagedClaim(page, "visible-role-resume");

  // From the first claim onward every transition below uses a visible control.
  await submitCorrectEvidence(page);
  await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Switch to Staff role" })).toBeVisible();
  await page.getByRole("button", { name: "Switch to Staff role" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("link", { name: "Open Staff review desk" })).toBeVisible();
  await page.getByRole("link", { name: "Open Staff review desk" }).click();
  await expect.poll(() => toolNames(page)).toEqual(["list_pending_claims"]);
  await executeTool(page, "list_pending_claims", { limit: 3 });
  await page.getByRole("link", { name: /earbuds/i }).click();
  await expect(page).toHaveURL(new RegExp(`/staff/claims/${staged.claimId}$`));

  await page.getByRole("button", { name: "Approve claim" }).click();
  await expect(page.locator(".status-stamp")).toContainText("APPROVED");
  await page.getByRole("button", { name: "Switch to Claimant role" }).click();
  await expect(page).toHaveURL(new RegExp(`/claimant/claims/${staged.claimId}$`));

  await page.getByRole("button", { name: "Generate pickup pass" }).click();
  const copyCredential = page.getByRole("button", { name: "Copy credential" });
  await expect(copyCredential).toBeVisible();
  await copyCredential.click();
  await page.getByRole("button", { name: "Switch to Staff role" }).click();
  await expect(page).toHaveURL(new RegExp(`/staff/claims/${staged.claimId}$`));

  const credentialInput = page.getByLabel("One-time pickup credential");
  await credentialInput.focus();
  await page.keyboard.press("Control+V");
  await page.getByRole("button", { name: "Confirm atomic handoff" }).click();
  await expect(page.locator(".status-stamp")).toContainText("COLLECTED");
  await expect.poll(() => toolNames(page)).toEqual(["get_claim_status"]);

  await page.getByRole("link", { name: "Staff review queue" }).click();
  await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect.poll(() => toolNames(page)).toEqual([]);
});
