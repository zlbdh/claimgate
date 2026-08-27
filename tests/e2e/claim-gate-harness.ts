import { randomUUID } from "node:crypto";
import { expect, type BrowserContext, type Page } from "@playwright/test";
import { readPrivateEvidenceSeedForTest } from "@/test/private-evidence-seed-reader";

type NativeToolDescriptor = Readonly<{
  name: string;
  description: string;
  inputSchema: string;
  annotations?: WebMCPTool["annotations"];
}>;

type ToolEnvelope<T> = Readonly<{
  ok: true;
  data: T;
  nextPath?: string;
}>;

export type DraftResult = Readonly<{
  reportId: string;
  status: "DRAFT";
  version: number;
}>;

export type CandidateMatch = Readonly<{
  candidateHandle: string;
  category: string;
  area: string;
  color: string;
}>;

export type MatchResult = Readonly<{
  reportVersion: number;
  candidates: readonly CandidateMatch[];
}>;

export type StagedClaim = Readonly<{
  claimId: string;
  status: "EVIDENCE_REQUIRED";
  version: number;
}>;

function idempotencyKey(action: string): string {
  return `e2e-${action}-${randomUUID()}`;
}

export async function installFaithfulModelContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const active = new Map<string, WebMCPTool>();
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: {
        async registerTool(tool: WebMCPTool, options?: { signal?: AbortSignal }) {
          if (active.has(tool.name)) {
            throw new DOMException("Duplicate tool", "InvalidStateError");
          }
          active.set(tool.name, tool);
          options?.signal?.addEventListener("abort", () => active.delete(tool.name), { once: true });
        },
        async getTools(): Promise<NativeToolDescriptor[]> {
          return [...active.values()]
            .sort((left, right) => left.name.localeCompare(right.name))
            .map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: JSON.stringify(tool.inputSchema),
              annotations: tool.annotations,
            }));
        },
        async executeTool(descriptor: NativeToolDescriptor, inputJson: string) {
          const tool = active.get(descriptor.name);
          if (!tool) throw new DOMException("Tool not found", "UnknownError");
          return JSON.stringify(await tool.execute(JSON.parse(inputJson)));
        },
      },
    });
  });
}

export async function toolNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const context = document.modelContext as unknown as {
      getTools(): Promise<NativeToolDescriptor[]>;
    };
    const tools = await context.getTools();
    for (const tool of tools) {
      const schema = JSON.parse(tool.inputSchema) as { type?: unknown };
      if (schema.type !== "object") throw new Error("Invalid native tool schema");
    }
    return tools.map(({ name }) => name);
  });
}

export async function executeTool<T>(page: Page, name: string, input: unknown): Promise<ToolEnvelope<T>> {
  return page.evaluate(async ({ toolName, toolInput }) => {
    const context = document.modelContext as unknown as {
      getTools(): Promise<NativeToolDescriptor[]>;
      executeTool(tool: NativeToolDescriptor, inputJson: string): Promise<string | null>;
    };
    const descriptor = (await context.getTools()).find((tool) => tool.name === toolName);
    if (!descriptor) throw new Error(`Missing native tool: ${toolName}`);
    const raw = await context.executeTool(descriptor, JSON.stringify(toolInput));
    if (raw === null) throw new Error(`Native tool returned null: ${toolName}`);
    return JSON.parse(raw) as ToolEnvelope<T>;
  }, { toolName: name, toolInput: input });
}

export async function startPublicDemo(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Start public demo" }).click();
  await expect(page.getByText("Current role: Claimant")).toBeVisible();
}

export async function switchRole(page: Page, role: "Claimant" | "Staff"): Promise<void> {
  await page.goto("/");
  const current = page.getByText(`Current role: ${role}`);
  if (await current.count() === 0) {
    await page.getByRole("button", { name: `Switch to ${role} role` }).click();
  }
  await expect(page.getByText(`Current role: ${role}`)).toBeVisible();
}

export async function openClaimantDesk(page: Page): Promise<void> {
  await page.goto("/claimant");
  await expect.poll(() => toolNames(page)).toEqual([
    "create_lost_report_draft",
    "list_my_reports",
  ]);
}

export async function createLostReportDraft(
  page: Page,
  label: string,
): Promise<DraftResult> {
  const result = await executeTool<DraftResult>(page, "create_lost_report_draft", {
    category: "earbuds",
    timeWindow: {
      from: "2026-08-25T17:00:00.000Z",
      to: "2026-08-25T19:00:00.000Z",
    },
    area: "library",
    color: "black",
    publicTags: ["wireless", "charging-case"],
    publicDescription: `Black wireless earbud case ${label}.`,
    idempotencyKey: idempotencyKey("create"),
  });
  expect(result).toMatchObject({ ok: true, data: { status: "DRAFT", version: 1 } });
  await expect(page).toHaveURL(new RegExp(`/claimant/reports/${result.data.reportId}$`));
  return result.data;
}

export async function publishLostReport(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Publish report manually" }).click();
  await expect(page.locator(".status-stamp")).toContainText("PUBLISHED");
  await expect.poll(() => toolNames(page)).toEqual(["find_candidate_matches", "list_my_reports"]);
}

export async function findCandidateMatches(page: Page, reportId: string): Promise<MatchResult> {
  const result = await executeTool<MatchResult>(page, "find_candidate_matches", {
    reportId,
    limit: 1,
  });
  expect(result).toMatchObject({ ok: true, data: { candidates: [expect.any(Object)] } });
  await expect.poll(() => toolNames(page)).toContain("stage_claim_candidate");
  return result.data;
}

export async function stageClaimCandidate(
  page: Page,
  reportId: string,
  match: MatchResult,
): Promise<StagedClaim> {
  const candidate = match.candidates[0];
  if (!candidate) throw new Error("No candidate available for staging");
  const result = await executeTool<StagedClaim>(page, "stage_claim_candidate", {
    reportId,
    candidateHandle: candidate.candidateHandle,
    expectedVersion: match.reportVersion,
    idempotencyKey: idempotencyKey("stage"),
  });
  expect(result).toMatchObject({
    ok: true,
    data: { status: "EVIDENCE_REQUIRED", version: 1 },
  });
  await expect(page).toHaveURL(new RegExp(`/claimant/claims/${result.data.claimId}$`));
  return result.data;
}

export async function createPublishedStagedClaim(page: Page, label: string): Promise<StagedClaim> {
  await openClaimantDesk(page);
  const draft = await createLostReportDraft(page, label);
  await publishLostReport(page);
  const match = await findCandidateMatches(page, draft.reportId);
  return stageClaimCandidate(page, draft.reportId, match);
}

export async function submitCorrectEvidence(page: Page, seedIndex = 0): Promise<void> {
  const evidence = readPrivateEvidenceSeedForTest(seedIndex);
  await page.getByLabel("Private evidence · unique mark").fill(evidence.unique_mark);
  await page.getByLabel("Private evidence · contents or accessory")
    .fill(evidence.contents_or_accessory);
  await page.getByRole("button", { name: "Submit private evidence" }).click();
  await expect(page.locator(".status-stamp")).toContainText("UNDER_REVIEW");
}

export async function expectNoOverflow(page: Page): Promise<void> {
  const layout = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    offenders: [...document.querySelectorAll<HTMLElement>("body *")]
      .filter((element) => element.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 8)
      .map((element) => ({
        tag: element.tagName,
        className: element.className,
        right: Math.round(element.getBoundingClientRect().right),
      })),
  }));
  expect(layout.scrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.clientWidth);
}
