import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { readPrivateEvidenceSeedForTest } from "@/test/private-evidence-seed-reader";

declare global {
  interface Window {
    __claimGateTesting?: {
      active: Map<string, WebMCPTool>;
      exercised: string[];
    };
  }
}

async function installFaithfulModelContext(page: Page) {
  await page.addInitScript(() => {
    const testing = { active: new Map<string, WebMCPTool>(), exercised: [] as string[] };
    window.__claimGateTesting = testing;
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        async registerTool(tool: WebMCPTool, options?: { signal?: AbortSignal }) {
          if (testing.active.has(tool.name)) throw new DOMException("Duplicate tool", "InvalidStateError");
          testing.active.set(tool.name, tool);
          options?.signal?.addEventListener("abort", () => testing.active.delete(tool.name), { once: true });
        },
        async getTools() {
          return [...testing.active.values()].sort((a, b) => a.name.localeCompare(b.name)).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: JSON.stringify(tool.inputSchema),
            annotations: tool.annotations,
          }));
        },
        async executeTool(descriptor: { name: string }, inputJson: string) {
          const tool = testing.active.get(descriptor.name);
          if (!tool) throw new DOMException("Tool not found", "UnknownError");
          testing.exercised.push(descriptor.name);
          return JSON.stringify(await tool.execute(JSON.parse(inputJson)));
        },
      },
    });
  });
}

async function toolNames(page: Page) {
  return page.evaluate(async () => {
    const context = document.modelContext as unknown as { getTools(): Promise<Array<{ name: string; inputSchema: string }>> };
    const tools = await context.getTools();
    tools.forEach((tool) => {
      const schema = JSON.parse(tool.inputSchema) as { type?: unknown };
      if (schema.type !== "object") throw new Error("invalid tool schema serialization");
    });
    return tools.map((tool) => tool.name);
  });
}

async function execute(page: Page, name: string, input: unknown) {
  return page.evaluate(async ({ toolName, toolInput }) => {
    const context = document.modelContext as unknown as {
      getTools(): Promise<Array<{ name: string }>>;
      executeTool(tool: { name: string }, inputJson: string): Promise<string | null>;
    };
    const descriptor = (await context.getTools()).find((tool) => tool.name === toolName);
    if (!descriptor) throw new Error(`missing ${toolName}`);
    const raw = await context.executeTool(descriptor, JSON.stringify(toolInput));
    return { raw, parsed: raw === null ? null : JSON.parse(raw) };
  }, { toolName: name, toolInput: input });
}

async function stageClaimForReview(page: Page, keySuffix: string) {
  await page.goto("/");
  await page.getByRole("button", { name: "Start public demo" }).click();
  await page.getByRole("link", { name: "Open Claimant report desk" }).click();
  await expect.poll(() => toolNames(page)).toContain("create_lost_report_draft");
  const created = await execute(page, "create_lost_report_draft", {
    category: "earbuds",
    timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
    area: "library", color: "black", publicTags: ["wireless", "charging-case"],
    publicDescription: "Black wireless earbud case.",
    idempotencyKey: `e2e-create-${keySuffix}-0001`,
  });
  await expect(page).toHaveURL(/\/claimant\/reports\//);
  await page.getByRole("button", { name: "Publish report manually" }).click();
  const reportId = page.url().split("/").at(-1)!;
  await expect.poll(() => toolNames(page)).toContain("find_candidate_matches");
  const found = await execute(page, "find_candidate_matches", { reportId, limit: 1 });
  await expect.poll(() => toolNames(page)).toContain("stage_claim_candidate");
  const staged = await execute(page, "stage_claim_candidate", {
    reportId,
    candidateHandle: found.parsed.data.candidates[0].candidateHandle,
    expectedVersion: found.parsed.data.reportVersion,
    idempotencyKey: `e2e-stage-${keySuffix}-0001`,
  });
  expect(created.parsed).toMatchObject({ ok: true });
  expect(staged.parsed).toMatchObject({ ok: true, data: { claimId: expect.any(String) } });
  await expect(page).toHaveURL(/\/claimant\/claims\//);
  return staged.parsed.data.claimId as string;
}

test("real provider executes all four tools across the production Claimant flow", async ({ page }, testInfo) => {
  const browserLogs: string[] = [];
  const pageErrors: string[] = [];
  const html: string[] = [];
  page.on("console", (message) => browserLogs.push(message.text()));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installFaithfulModelContext(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Start public demo" }).click();
  await page.getByRole("link", { name: "Open Claimant report desk" }).click();
  await expect.poll(() => toolNames(page)).toEqual(["create_lost_report_draft", "list_my_reports"]);
  html.push(await page.content());
  expect((await execute(page, "list_my_reports", {})).parsed).toEqual({ ok: true, data: { reports: [] } });

  const created = await execute(page, "create_lost_report_draft", {
    category: "earbuds",
    timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
    area: "library", color: "black", publicTags: ["wireless", "charging-case"],
    publicDescription: "Black wireless earbud case.", idempotencyKey: "e2e-create-00000001",
  });
  expect(created.raw).not.toBeNull();
  await expect(page).toHaveURL(/\/claimant\/reports\//);
  await expect.poll(() => toolNames(page)).toEqual(["list_my_reports"]);
  html.push(await page.content());
  await page.getByRole("button", { name: "Publish report manually" }).click();
  await expect.poll(() => toolNames(page)).toEqual(["find_candidate_matches", "list_my_reports"]);
  html.push(await page.content());

  const reportId = page.url().split("/").at(-1)!;
  const found = await execute(page, "find_candidate_matches", { reportId, limit: 1 });
  expect(found.parsed).toMatchObject({ ok: true, data: { reportVersion: 2, candidates: [expect.objectContaining({ candidateHandle: expect.stringMatching(/^cgch1\./) })] } });
  await expect.poll(() => toolNames(page)).toEqual([
    "find_candidate_matches", "list_my_reports", "stage_claim_candidate",
  ]);
  const staged = await execute(page, "stage_claim_candidate", {
    reportId,
    candidateHandle: found.parsed.data.candidates[0].candidateHandle,
    expectedVersion: found.parsed.data.reportVersion,
    idempotencyKey: "e2e-stage-00000001",
  });
  expect(staged.raw).not.toBeNull();
  await expect(page).toHaveURL(/\/claimant\/claims\//);
  await expect(page.getByRole("heading", { name: "Evidence checkpoint" })).toBeVisible();
  const claimResponse = await page.context().request.get(page.url());
  expect(claimResponse.headers()["cache-control"]).toContain("private");
  expect(claimResponse.headers()["cache-control"]).toContain("no-store");
  await expect.poll(() => toolNames(page)).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("claim-checkpoint-desktop.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("claim-checkpoint-mobile.png"), fullPage: true });
  const mobileLayout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        right: Math.round(element.getBoundingClientRect().right),
        width: Math.round(element.getBoundingClientRect().width),
      })),
  }));
  expect(mobileLayout.scrollWidth, JSON.stringify(mobileLayout)).toBeLessThanOrEqual(mobileLayout.clientWidth);
  const evidence = readPrivateEvidenceSeedForTest(0);
  await page.getByLabel("Private evidence · unique mark").fill(evidence.unique_mark);
  await page.getByLabel("Private evidence · contents or accessory").fill(evidence.contents_or_accessory);
  await page.getByRole("button", { name: "Submit private evidence" }).click();
  await expect(page.getByRole("heading", { name: "Waiting for Staff review" })).toBeVisible();
  await expect(page.locator('input[type="password"]')).toHaveCount(0);
  html.push(await page.content());
  const activity = await page.locator(".agent-activity").innerText();
  await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
  await expect.poll(() => toolNames(page)).toEqual([]);
  await page.getByRole("button", { name: "Switch to Staff role" }).click();
  await page.getByRole("link", { name: "Open Staff review desk" }).click();
  await expect(page.getByLabel(/Waiting (<1 min|\d+ min|\d+ hrs?)/)).toBeVisible();
  await page.getByRole("link", { name: /earbuds/i }).click();
  await expect(page.getByRole("heading", { name: "Staff decision" })).toBeVisible();
  const timelineTimes = page.locator(".timeline-list time");
  await expect(timelineTimes).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    await expect(timelineTimes.nth(index)).toHaveAttribute("datetime", /Z$/);
    await expect(timelineTimes.nth(index)).toContainText("UTC");
  }
  await expect(page.locator(".timeline-list")).toContainText(/claimant.*(CREATED|ELIGIBLE)/);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("staff-review-desktop.png"), fullPage: true });
  await page.getByRole("button", { name: "Approve claim" }).click();
  await expect(page.locator(".status-stamp")).toContainText("APPROVED");
  const staffResponse = await page.context().request.get(page.url());
  expect(staffResponse.headers()["cache-control"]).toContain("private");
  expect(staffResponse.headers()["cache-control"]).toContain("no-store");
  html.push(await page.content());

  const forbidden = /inventoryItemId|catalogVersion|foundAt|score|csrf|cookie|session|stack/i;
  expect(JSON.stringify([created, found, staged])).not.toMatch(forbidden);
  expect(activity).not.toMatch(/cgch1|report-public|claim-public|csrf|cookie|session/i);
  const databasePath = process.env.CLAIMGATE_E2E_DATABASE_PATH;
  expect(databasePath).toBeTruthy();
  const database = new Database(databasePath!, { readonly: true });
  const internalIds = (database.prepare("SELECT id FROM found_items").all() as Array<{ id: string }>).map((row) => row.id);
  database.close();
  const inspected = JSON.stringify({ results: [created, found, staged], html, activity, browserLogs });
  for (const internalId of internalIds) expect(inspected).not.toContain(internalId);
  expect(pageErrors).toEqual([]);
  expect(browserLogs.filter((entry) => /hydration|uncaught|console error/i.test(entry))).toEqual([]);
  await expect(page.locator("body")).not.toContainText(/Publish report manually|Archive published report/, { useInnerText: true });
});

test("unsupported browser keeps manual Claimant controls available", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Start public demo" }).click();
  await page.getByRole("link", { name: "Open Claimant report desk" }).click();
  await expect(page.getByText(/Agent collaboration needs a supported environment/i)).toBeVisible();
  await expect(page.getByRole("button", { name: "Save private draft" })).toBeEnabled();
});

test("manual failure lock, one unlock, second lock, and password clearing boundary", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  const browserLogs: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => browserLogs.push(message.text()));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installFaithfulModelContext(page);
  const claimId = await stageClaimForReview(page, "lockflow");
  const claimPath = `/claimant/claims/${claimId}`;
  const bfcacheCanaries = Array.from({ length: 3 }, () => `bf-${crypto.randomUUID()}`);
  let passwordFields = page.locator('input[type="password"]');
  for (let index = 0; index < 3; index += 1) await passwordFields.nth(index).fill(bfcacheCanaries[index]!);
  await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${claimPath}$`));
  passwordFields = page.locator('input[type="password"]');
  for (let index = 0; index < 3; index += 1) await expect(passwordFields.nth(index)).toHaveValue("");
  await page.goForward();
  await expect(page).toHaveURL(/\/$/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${claimPath}$`));
  passwordFields = page.locator('input[type="password"]');
  for (let index = 0; index < 3; index += 1) await expect(passwordFields.nth(index)).toHaveValue("");
  await page.reload();
  for (let index = 0; index < 3; index += 1) await expect(passwordFields.nth(index)).toHaveValue("");
  const restoredSurface = JSON.stringify({ html: await page.content(), url: page.url(), browserLogs });
  for (const canary of bfcacheCanaries) expect(restoredSurface).not.toContain(canary);

  await page.route("**/api/claims/*/evidence", (route) => route.abort());
  passwordFields = page.locator('input[type="password"]');
  await expect(passwordFields).toHaveCount(3);
  await passwordFields.nth(0).fill("network-only-canary");
  await page.getByRole("button", { name: "Submit private evidence" }).click();
  await expect(page.getByText(/connection failed/i)).toBeVisible();
  for (let index = 0; index < 3; index += 1) await expect(passwordFields.nth(index)).toHaveValue("");
  await page.unroute("**/api/claims/*/evidence");
  await page.reload();
  for (let index = 0; index < 3; index += 1) await expect(passwordFields.nth(index)).toHaveValue("");

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.getByRole("button", { name: "Submit private evidence" }).click();
    if (attempt < 3) {
      await expect(page.locator(".checkpoint-ledger")).toContainText(`Failed attempts${attempt}`);
      for (let index = 0; index < 3; index += 1) await expect(passwordFields.nth(index)).toHaveValue("");
    } else {
      await expect(page.getByRole("heading", { name: "Evidence attempts locked" })).toBeVisible();
      await expect(passwordFields).toHaveCount(0);
    }
  }

  await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
  await page.getByRole("button", { name: "Switch to Staff role" }).click();
  await page.goto(`/staff/claims/${claimId}`);
  await page.getByRole("button", { name: "Unlock claim" }).click();
  await expect(page.locator(".status-stamp")).toContainText("EVIDENCE_REQUIRED");
  await page.goto("/");
  await page.getByRole("button", { name: "Switch to Claimant role" }).click();
  await page.goto(claimPath);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.getByRole("button", { name: "Submit private evidence" }).click();
    if (attempt < 3) await expect(page.locator(".checkpoint-ledger")).toContainText(`Failed attempts${attempt}`);
    else await expect(page.getByRole("heading", { name: "Evidence attempts locked" })).toBeVisible();
  }
  await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
  await page.getByRole("button", { name: "Switch to Staff role" }).click();
  await page.goto(`/staff/claims/${claimId}`);
  await expect(page.getByRole("button", { name: "Unlock claim" })).toHaveCount(0);
  await expect(page.locator(".checkpoint-ledger")).toContainText("Unlock used1/1");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: testInfo.outputPath("second-lock-desktop.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath("second-lock-mobile.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(browserLogs.filter((entry) => /hydration|uncaught|console error/i.test(entry))).toEqual([]);
});
export {};
