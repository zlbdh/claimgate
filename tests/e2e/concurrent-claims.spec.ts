import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import {
  createPublishedStagedClaim,
  installFaithfulModelContext,
  startPublicDemo,
  submitCorrectEvidence,
  switchRole,
} from "./claim-gate-harness";

const FORBIDDEN_INTERNAL_FIELDS = /inventoryItemId|catalogVersion|pickup_pass_digest/i;

async function status(page: Page): Promise<string> {
  return (await page.locator(".status-stamp").innerText()).trim();
}

test("competing browser claims resolve to one winner and one explained loser", async ({
  context,
  page,
}) => {
  test.setTimeout(90_000);
  await installFaithfulModelContext(context);
  await startPublicDemo(page);

  const first = await createPublishedStagedClaim(page, "competing A");
  await submitCorrectEvidence(page);
  const second = await createPublishedStagedClaim(page, "competing B");
  await submitCorrectEvidence(page);

  await switchRole(page, "Staff");
  const firstReview = await context.newPage();
  const secondReview = await context.newPage();
  await Promise.all([
    firstReview.goto(`/staff/claims/${first.claimId}`),
    secondReview.goto(`/staff/claims/${second.claimId}`),
  ]);
  await expect(firstReview.getByRole("button", { name: "Approve claim" })).toBeVisible();
  await expect(secondReview.getByRole("button", { name: "Approve claim" })).toBeVisible();

  await Promise.all([
    firstReview.getByRole("button", { name: "Approve claim" }).click(),
    secondReview.getByRole("button", { name: "Approve claim" }).click(),
  ]);
  await Promise.all([firstReview.reload(), secondReview.reload()]);

  const reviews = [firstReview, secondReview];
  const statuses = await Promise.all(reviews.map((review) => status(review)));
  expect([...statuses].sort()).toEqual(["APPROVED", "REJECTED"]);
  const loser = reviews[statuses.indexOf("REJECTED")]!;
  await expect(loser.getByText(/another claim secured this item/i)).toBeVisible();
  await expect(loser.locator(".timeline-list")).toContainText("COMPETING_REJECTED");

  const rendered = (await Promise.all(reviews.map((review) => review.content()))).join("\n");
  expect(rendered).not.toMatch(FORBIDDEN_INTERNAL_FIELDS);
  const databasePath = process.env.CLAIMGATE_E2E_DATABASE_PATH;
  expect(databasePath).toBeTruthy();
  const database = new Database(databasePath!, { readonly: true });
  const internalIds = (database.prepare("SELECT id FROM found_items").all() as Array<{ id: string }>)
    .map(({ id }) => id);
  database.close();
  for (const internalId of internalIds) expect(rendered).not.toContain(internalId);
  await page.goto("/staff");
  await expect(page.getByText("No claims are waiting.")).toBeVisible();
  await expect(page.getByText("Queue · 0/50")).toBeVisible();
});
