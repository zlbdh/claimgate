import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { resolvePlaywrightTarget } from "../../scripts/playwright-target";
import {
  createLostReportDraft,
  createPublishedStagedClaim,
  expectNoOverflow,
  findCandidateMatches,
  installFaithfulModelContext,
  openClaimantDesk,
  publishLostReport,
  stageClaimCandidate,
  startPublicDemo,
  submitCorrectEvidence,
  switchRole,
  toolNames,
} from "./claim-gate-harness";

type PickupRow = Readonly<{
  demoInstanceId: string;
  generation: number;
  version: number;
}>;

type PickupState = Readonly<{ status: string; version: number; generation: number }>;
type ExpiryFixture = Readonly<{
  salt: string;
  digest: string;
  generation: number;
  expiresAtMs: number;
}>;

function databasePath(): string {
  const value = process.env.CLAIMGATE_E2E_DATABASE_PATH;
  if (!value) throw new Error("E2E database path is unavailable");
  return value;
}

function readPickupState(claimId: string): PickupState {
  const database = new Database(databasePath(), { readonly: true });
  try {
    const row = database.prepare(`
      SELECT status, version, pass_generation AS generation FROM claims WHERE id = ?
    `).get(claimId) as PickupState | undefined;
    if (!row) throw new Error("Pickup claim is unavailable");
    return row;
  } finally {
    database.close();
  }
}

function generateExpiredFixture(input: PickupRow & { claimId: string; token: string }): ExpiryFixture {
  const masterKey = resolvePlaywrightTarget({}).webServer?.env.CLAIMGATE_HMAC_KEY;
  if (!masterKey) throw new Error("Local E2E HMAC key is unavailable");
  const child = spawnSync(process.execPath, [
    "--conditions=react-server",
    "--import=tsx",
    resolve("tests/e2e/pickup-expiry-fixture-worker.ts"),
  ], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: JSON.stringify({ ...input, masterKey }),
    maxBuffer: 64 * 1_024,
    windowsHide: true,
  });
  if (child.status !== 0 || child.error || !child.stdout) {
    throw new Error("Production pickup fixture worker failed");
  }
  const fixture = JSON.parse(child.stdout) as ExpiryFixture;
  const salt = Buffer.from(fixture.salt, "base64");
  const digest = Buffer.from(fixture.digest, "base64");
  if (
    salt.length !== 32 || salt.toString("base64") !== fixture.salt
    || digest.length !== 32 || digest.toString("base64") !== fixture.digest
    || fixture.generation !== input.generation + 1
    || !Number.isSafeInteger(fixture.expiresAtMs)
    || fixture.expiresAtMs < 1 || fixture.expiresAtMs >= Date.now()
  ) throw new Error("Production pickup fixture was invalid");
  return fixture;
}

function expirePickupPassInDatabase(claimId: string, token: string): void {
  const database = new Database(databasePath());
  database.pragma("busy_timeout = 5000");
  try {
    const row = database.prepare(`
      SELECT demo_instance_id AS demoInstanceId, pass_generation AS generation, version
      FROM claims WHERE id = ? AND status = 'PICKUP_READY'
    `).get(claimId) as PickupRow | undefined;
    if (!row) throw new Error("Pickup-ready claim is unavailable");
    const fixture = generateExpiredFixture({ ...row, claimId, token });
    const result = database.prepare(`
      UPDATE claims SET status = 'PICKUP_READY', pickup_pass_salt = ?,
        pickup_pass_digest = ?, pickup_pass_expires_at_ms = ?,
        pickup_pass_consumed_at_ms = NULL, pass_generation = ?, version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND version = ?
        AND status = 'PICKUP_READY' AND pass_generation = ?
    `).run(
      Buffer.from(fixture.salt, "base64"), Buffer.from(fixture.digest, "base64"),
      BigInt(fixture.expiresAtMs), fixture.generation,
      row.demoInstanceId, claimId, row.version, row.generation,
    );
    expect(result.changes).toBe(1);
  } finally {
    database.close();
  }
}

async function createApprovedClaim(page: Page, label: string): Promise<string> {
  const staged = await createPublishedStagedClaim(page, label);
  await submitCorrectEvidence(page);
  await switchRole(page, "Staff");
  await page.goto(`/staff/claims/${staged.claimId}`);
  await page.getByRole("button", { name: "Approve claim" }).click();
  await expect(page.locator(".status-stamp")).toContainText("APPROVED");
  await switchRole(page, "Claimant");
  await page.goto(`/claimant/claims/${staged.claimId}`);
  return staged.claimId;
}

test.beforeEach(async ({ context }) => {
  await installFaithfulModelContext(context);
});

test("one Staff unlock permits a correct evidence resubmission", async ({ page }) => {
  await startPublicDemo(page);
  const staged = await createPublishedStagedClaim(page, "unlock-success");
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.getByRole("button", { name: "Submit private evidence" }).click();
    if (attempt < 3) {
      await expect(page.locator(".checkpoint-ledger")).toContainText(`Failed attempts${attempt}`);
    } else {
      await expect(page.getByRole("heading", { name: "Evidence attempts locked" })).toBeVisible();
    }
  }
  await switchRole(page, "Staff");
  await page.goto(`/staff/claims/${staged.claimId}`);
  await page.getByRole("button", { name: "Unlock claim" }).click();
  await expect(page.locator(".status-stamp")).toContainText("EVIDENCE_REQUIRED");
  await switchRole(page, "Claimant");
  await page.goto(`/claimant/claims/${staged.claimId}`);
  await submitCorrectEvidence(page);
  await expect.poll(() => toolNames(page)).toEqual(["get_claim_status"]);
});

test("a stale draft tab reports STATE_CHANGED and preserves the winning update", async ({ context, page }) => {
  await startPublicDemo(page);
  await openClaimantDesk(page);
  const draft = await createLostReportDraft(page, "stale-update");
  const stale = await context.newPage();
  await stale.goto(`/claimant/reports/${draft.reportId}`);
  await expect(stale.locator(".workspace-header").getByText(/revision 1/i)).toBeVisible();

  await page.getByLabel("Public description").fill("Winning update from tab A.");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.locator(".workspace-header").getByText(/revision 2/i)).toBeVisible();

  await stale.getByLabel("Public description").fill("Stale update from tab B.");
  await stale.getByRole("button", { name: "Save changes" }).click();
  const staleAlert = stale.locator(".form-error");
  await expect(staleAlert).toContainText("STATE_CHANGED");
  await expect(staleAlert).toContainText(/reload/i);
  await page.reload();
  await expect(page.getByLabel("Public description")).toHaveValue("Winning update from tab A.");
  await expect(page.locator(".workspace-header").getByText(/revision 2/i)).toBeVisible();
});

test("an expired server credential is denied and explicit reissue recovers", async ({ page }) => {
  test.setTimeout(60_000);
  test.skip(Boolean(process.env.PLAYWRIGHT_BASE_URL), "Requires the isolated local E2E SQLite fixture");
  await startPublicDemo(page);
  const claimId = await createApprovedClaim(page, "server-expiry");
  const issueResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/claims/${claimId}/pickup-pass/issue`));
  await page.getByRole("button", { name: "Generate pickup pass" }).click();
  const issued = await (await issueResponse).json() as { token: string };
  expirePickupPassInDatabase(claimId, issued.token);
  const beforeDeniedHandoff = readPickupState(claimId);

  await switchRole(page, "Staff");
  await page.goto(`/staff/claims/${claimId}`);
  await page.getByLabel("One-time pickup credential").fill(issued.token);
  const handoffPattern = `**/api/staff/claims/${claimId}/handoff`;
  let resolveDenied!: (value: { status: number; body: unknown }) => void;
  const deniedResponse = new Promise<{ status: number; body: unknown }>((resolveCapture) => {
    resolveDenied = resolveCapture;
  });
  await page.route(handoffPattern, async (route) => {
    const upstream = await route.fetch();
    const body = await upstream.body();
    await route.fulfill({ response: upstream, body });
    resolveDenied({ status: upstream.status(), body: JSON.parse(body.toString("utf8")) as unknown });
  });
  await page.getByRole("button", { name: "Confirm atomic handoff" }).click();
  const denied = await deniedResponse;
  expect(denied.status).toBe(403);
  await expect(page.getByText(/credential denied/i)).toBeVisible();
  expect(denied.body).toMatchObject({ error: { code: "FORBIDDEN" } });
  await page.unroute(handoffPattern);
  await expect(page.locator(".status-stamp")).toContainText("PICKUP_READY");
  expect(readPickupState(claimId)).toEqual(beforeDeniedHandoff);

  await switchRole(page, "Claimant");
  await page.goto(`/claimant/claims/${claimId}`);
  const reissueResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/claims/${claimId}/pickup-pass/reissue`));
  await page.getByRole("button", { name: "Reissue pickup pass" }).click();
  const reissued = await reissueResponse;
  expect(reissued.status()).toBe(200);
  expect((await reissued.json() as { token: string }).token).not.toBe(issued.token);
});

test("the mobile report, candidate, and evidence path stays accessible without overflow", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startPublicDemo(page);
  await openClaimantDesk(page);
  await expectNoOverflow(page);
  await expect(page.getByRole("form", { name: "Create lost report draft" })).toBeVisible();
  await page.getByLabel("Category").fill("earbuds");
  await page.getByLabel("From").fill("2026-08-25T17:00");
  await page.getByLabel("To", { exact: true }).fill("2026-08-25T19:00");
  await page.getByLabel("Area").fill("library");
  await page.getByLabel("Color").fill("black");
  await page.getByLabel("Public descriptors").fill("wireless, charging-case");
  await page.getByLabel("Public description").fill("Mobile black earbud case.");
  await page.getByRole("button", { name: "Save private draft" }).click();
  await expect(page).toHaveURL(/\/claimant\/reports\//);
  const reportId = page.url().split("/").at(-1)!;
  await expectNoOverflow(page);
  await expect(page.getByRole("form", { name: "Update lost report draft" })).toBeVisible();

  await publishLostReport(page);
  await expectNoOverflow(page);
  await page.getByRole("button", { name: "Find candidates" }).click();
  await expect(page.getByRole("article", { name: /candidate/i }).first()).toBeVisible();
  await expectNoOverflow(page);
  const match = await findCandidateMatches(page, reportId);
  await stageClaimCandidate(page, reportId, match);
  await expect(page.getByRole("form", { name: "Private evidence" })).toBeVisible();
  await expectNoOverflow(page);
});
