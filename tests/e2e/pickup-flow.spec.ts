import { expect, test, type Page } from "@playwright/test";
import { readPrivateEvidenceSeedForTest } from "@/test/private-evidence-seed-reader";

declare global {
  interface Window {
    __pickupTesting?: { active: Map<string, WebMCPTool> };
  }
}

async function installModelContext(page: Page) {
  await page.addInitScript(() => {
    const testing = { active: new Map<string, WebMCPTool>() };
    window.__pickupTesting = testing;
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        async registerTool(tool: WebMCPTool, options?: { signal?: AbortSignal }) {
          testing.active.set(tool.name, tool);
          options?.signal?.addEventListener("abort", () => testing.active.delete(tool.name), { once: true });
        },
        async getTools() {
          return [...testing.active.values()].map((tool) => ({
            name: tool.name, description: tool.description,
            inputSchema: JSON.stringify(tool.inputSchema), annotations: tool.annotations,
          }));
        },
        async executeTool(descriptor: { name: string }, inputJson: string) {
          const tool = testing.active.get(descriptor.name);
          if (!tool) throw new Error("tool missing");
          return JSON.stringify(await tool.execute(JSON.parse(inputJson)));
        },
      },
    });
  });
}

async function execute(page: Page, name: string, input: unknown) {
  return page.evaluate(async ({ name, input }) => {
    const context = document.modelContext as unknown as {
      getTools(): Promise<Array<{ name: string }>>;
      executeTool(tool: { name: string }, input: string): Promise<string>;
    };
    const descriptor = (await context.getTools()).find((tool) => tool.name === name);
    if (!descriptor) throw new Error(`missing ${name}`);
    return JSON.parse(await context.executeTool(descriptor, JSON.stringify(input)));
  }, { name, input });
}

async function toolNames(page: Page) {
  return page.evaluate(async () => {
    const context = document.modelContext as unknown as { getTools(): Promise<Array<{ name: string }>> };
    return (await context.getTools()).map(({ name }) => name);
  });
}

async function reachApproved(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Start public demo" }).click();
  await page.getByRole("link", { name: "Open Claimant report desk" }).click();
  await expect.poll(() => toolNames(page)).toContain("create_lost_report_draft");
  const created = await execute(page, "create_lost_report_draft", {
    category: "earbuds",
    timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
    area: "library", color: "black", publicTags: ["wireless"],
    publicDescription: "Black wireless earbud case.",
    idempotencyKey: "pickup-e2e-create-0001",
  });
  expect(created).toMatchObject({ ok: true });
  await page.getByRole("button", { name: "Publish report manually" }).click();
  const reportId = page.url().split("/").at(-1)!;
  await expect.poll(() => toolNames(page)).toContain("find_candidate_matches");
  const found = await execute(page, "find_candidate_matches", { reportId, limit: 1 });
  await expect.poll(() => toolNames(page)).toContain("stage_claim_candidate");
  const staged = await execute(page, "stage_claim_candidate", {
    reportId,
    candidateHandle: found.data.candidates[0].candidateHandle,
    expectedVersion: found.data.reportVersion,
    idempotencyKey: "pickup-e2e-stage-0001",
  });
  const claimId = staged.data.claimId as string;
  const evidence = readPrivateEvidenceSeedForTest(0);
  await page.getByLabel("Private evidence · unique mark").fill(evidence.unique_mark);
  await page.getByLabel("Private evidence · contents or accessory").fill(evidence.contents_or_accessory);
  await page.getByRole("button", { name: "Submit private evidence" }).click();
  await expect(page.locator(".status-stamp")).toContainText("UNDER_REVIEW");
  await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
  await page.getByRole("button", { name: "Switch to Staff role" }).click();
  await page.goto(`/staff/claims/${claimId}`);
  await page.getByRole("button", { name: "Approve claim" }).click();
  await expect(page.locator(".status-stamp")).toContainText("APPROVED");
  await page.getByRole("link", { name: "Staff review queue" }).click();
  await page.goto("/");
  await page.getByRole("button", { name: "Switch to Claimant role" }).click();
  await page.goto(`/claimant/claims/${claimId}`);
  return claimId;
}

test("approve, issue, reissue and atomic handoff keep the credential client-only", async ({ page, context }) => {
  test.setTimeout(90_000);
  const consoleMessages: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await installModelContext(page);
  const claimId = await reachApproved(page);
  await expect(page.getByRole("button", { name: "Generate pickup pass" })).toBeVisible();
  const issueResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/claims/${claimId}/pickup-pass/issue`));
  await page.getByRole("button", { name: "Generate pickup pass" }).click();
  const issuedResponse = await issueResponse;
  const issued = await issuedResponse.json() as { token: string };
  expect(issuedResponse.headers()["cache-control"]).toBe("private, no-store");
  expect(issuedResponse.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(page.locator("canvas")).toBeVisible();
  expect(await page.locator("canvas").evaluate((canvas) => ({
    width: (canvas as HTMLCanvasElement).width,
    height: (canvas as HTMLCanvasElement).height,
  }))).toEqual({ width: 224, height: 224 });
  await expect(page.locator("body")).not.toContainText(issued.token);
  await page.getByRole("button", { name: "Reveal credential" }).click();
  await expect(page.getByText(issued.token)).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify({
    history: history.state,
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    url: location.href,
  })).then((value) => value.includes(issued.token))).toBe(false);

  await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
  await page.goBack();
  await expect(page.locator("body")).not.toContainText(issued.token);
  const restoredCanvas = page.locator("canvas");
  if (await restoredCanvas.count()) {
    expect(await restoredCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBe(0);
  }
  await page.goto(`/claimant/claims/${claimId}`);
  await expect(page.getByRole("button", { name: "Reissue pickup pass" })).toBeVisible();
  const reissueResponse = page.waitForResponse((response) =>
    response.url().endsWith(`/api/claims/${claimId}/pickup-pass/reissue`));
  await page.getByRole("button", { name: "Reissue pickup pass" }).click();
  const reissued = await (await reissueResponse).json() as { token: string };
  expect(reissued.token).not.toBe(issued.token);
  await page.getByRole("button", { name: "Reveal credential" }).click();
  await expect(page.getByText(reissued.token)).toBeVisible();

  await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
  await page.getByRole("button", { name: "Switch to Staff role" }).click();
  await page.goto(`/staff/claims/${claimId}`);
  const credentialInput = page.getByLabel("One-time pickup credential");
  await credentialInput.fill(issued.token);
  await page.getByRole("button", { name: "Confirm atomic handoff" }).click();
  await expect(page.getByText(/credential denied/i)).toBeVisible();
  await expect(credentialInput).toHaveValue("");

  const second = await context.newPage();
  second.on("console", (message) => consoleMessages.push(message.text()));
  second.on("pageerror", (error) => pageErrors.push(error.message));
  await second.goto(`/staff/claims/${claimId}`);
  await credentialInput.fill(reissued.token);
  await second.getByLabel("One-time pickup credential").fill(reissued.token);
  await Promise.all([
    page.getByRole("button", { name: "Confirm atomic handoff" }).click(),
    second.getByRole("button", { name: "Confirm atomic handoff" }).click(),
  ]);
  await expect(page.locator(".status-stamp")).toContainText("COLLECTED");
  await expect(second.locator(".status-stamp")).toContainText("COLLECTED");
  await expect(page.getByText(/item returned and report resolved/i)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(pageErrors).toEqual([]);
  expect(consoleMessages.filter((entry) => /hydration|uncaught|console error/i.test(entry))).toEqual([]);
  expect(JSON.stringify(consoleMessages)).not.toContain(issued.token);
  expect(JSON.stringify(consoleMessages)).not.toContain(reissued.token);
});

export {};
