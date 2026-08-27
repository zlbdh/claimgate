import { Buffer } from "node:buffer";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { chromium, type Page } from "@playwright/test";
import { readPrivateEvidenceSeedForTest } from "@/test/private-evidence-seed-reader";
import {
  cleanupNativeRun,
  createEvidenceTransportCanary,
  forbidRuntimeSecrets,
  freeNativePort,
  requireSingleTransportOccurrence,
} from "./native-secret-canary";
type NativeTool = Readonly<{
  name: string;
  description: string;
  inputSchema: string;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
}>;
type NativeContext = Readonly<{
  getTools(): Promise<NativeTool[]>;
  executeTool(tool: NativeTool, inputJson: string): Promise<string | null>;
}>;
const phases: Array<{ phase: string; tools: string[]; schemas: string[] }> = [];
const executedTools = new Set<string>();
const WRITES = new Set(["create_lost_report_draft", "update_lost_report_draft", "stage_claim_candidate"]);
const UNTRUSTED = new Set(["list_my_reports", "find_candidate_matches", "list_pending_claims", "get_claim_review_summary"]);
async function waitForServer(origin: string, process: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error("Production server exited before readiness");
    try {
      const response = await fetch(origin, { cache: "no-store" });
      if (response.ok) return;
    } catch {
      // Readiness is condition-polled because startup time varies across hosts.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Production server readiness timed out");
}
async function nativeTools(page: Page): Promise<NativeTool[] | null> {
  return page.evaluate(async () => {
    const context = document.modelContext as unknown as NativeContext | undefined;
    return context ? context.getTools() : null;
  });
}

async function expectTools(page: Page, phase: string, expected: string[]): Promise<NativeTool[]> {
  const deadline = Date.now() + 10_000;
  let stable = 0;
  let tools: NativeTool[] | null = null;
  while (Date.now() < deadline) {
    tools = await nativeTools(page);
    if (!tools) throw new Error("Chrome did not expose document.modelContext");
    const matches = JSON.stringify(tools.map((tool) => tool.name)) === JSON.stringify(expected);
    stable = matches ? stable + 1 : 0;
    if (stable >= 3) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (stable < 3 || !tools) {
    throw new Error(`${phase} tool membership did not stabilize: ${JSON.stringify(tools?.map(({ name }) => name))}`);
  }
  for (const tool of tools) {
    if (typeof tool.inputSchema !== "string") throw new Error("Chrome 151 inputSchema was not a string");
    const parsed = JSON.parse(tool.inputSchema) as { type?: unknown; additionalProperties?: unknown };
    if (parsed.type !== "object" || parsed.additionalProperties !== false) {
      throw new Error("Native tool schema was not a strict object");
    }
    if (tool.annotations?.readOnlyHint !== !WRITES.has(tool.name)
      || tool.annotations?.untrustedContentHint !== UNTRUSTED.has(tool.name)) {
      throw new Error(`Native tool annotations were incorrect for ${tool.name}`);
    }
  }
  phases.push({ phase, tools: tools.map((tool) => tool.name), schemas: tools.map((tool) => `${tool.name}:JSON-string`) });
  return tools;
}

async function execute(page: Page, name: string, input: unknown): Promise<{ raw: string; parsed: Record<string, unknown> }> {
  const result = await page.evaluate(async ({ toolName, toolInput }) => {
    const context = document.modelContext as unknown as NativeContext | undefined;
    if (!context) throw new Error("No native modelContext");
    const descriptor = (await context.getTools()).find((tool) => tool.name === toolName);
    if (!descriptor) throw new Error("Native tool is not registered in this phase");
    return { raw: await context.executeTool(descriptor, JSON.stringify(toolInput)) };
  }, { toolName: name, toolInput: input });
  if (result.raw === null || typeof result.raw !== "string") {
    throw new Error(`${name} returned a cross-document null result`);
  }
  const parsed = JSON.parse(result.raw) as Record<string, unknown>;
  if (parsed.ok !== true) throw new Error(`${name} returned an error envelope`);
  executedTools.add(name);
  return { raw: result.raw, parsed };
}

async function main() {
  const directory = mkdtempSync(join(tmpdir(), "claimgate-native-"));
  const databasePath = join(directory, "native.sqlite");
  const port = await freeNativePort();
  const origin = `http://127.0.0.1:${port}`;
  const serverLogs: string[] = [];
  const server = spawn(process.execPath, ["scripts/start-standalone.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      PLAYWRIGHT_HOSTNAME: "127.0.0.1",
      CLAIMGATE_HMAC_KEY: Buffer.alloc(32, 91).toString("base64"),
      CLAIMGATE_SESSION_KEY: Buffer.alloc(32, 92).toString("base64"),
      CLAIMGATE_CSRF_KEY: Buffer.alloc(32, 93).toString("base64"),
      CLAIMGATE_DATABASE_PATH: databasePath,
      CLAIMGATE_APP_ORIGIN: origin,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", (chunk) => serverLogs.push(String(chunk)));
  server.stderr?.on("data", (chunk) => serverLogs.push(String(chunk)));
  let browser;
  try {
    await waitForServer(origin, server);
    browser = await chromium.launch({ headless: true, args: ["--enable-features=WebMCPTesting"] });
    const page = await browser.newPage();
    const clientLogs: string[] = [];
    page.on("console", (message) => clientLogs.push(message.text()));
    const html: string[] = [];
    const rawResults: string[] = [];

    await page.goto(origin);
    await page.getByRole("button", { name: "Start public demo" }).click();
    await page.getByRole("link", { name: "Open Claimant report desk" }).click();
    const workspace = await expectTools(page, "Claimant workspace", ["create_lost_report_draft", "list_my_reports"]);
    rawResults.push((await execute(page, "list_my_reports", {})).raw);
    const created = await execute(page, "create_lost_report_draft", {
      category: "earbuds",
      timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
      area: "library", color: "black", publicTags: ["wireless", "charging-case"],
      publicDescription: "Black wireless earbud case.", idempotencyKey: "native-create-0000001",
    });
    rawResults.push(created.raw);
    const createdData = created.parsed.data as Record<string, unknown>;
    if (createdData.status !== "DRAFT" || typeof created.parsed.nextPath !== "string") throw new Error("Invalid create result");
    await page.waitForURL(`${origin}${created.parsed.nextPath}`);
    await expectTools(page, "DRAFT report", ["list_my_reports", "update_lost_report_draft"]);
    const reportId = createdData.reportId as string;
    rawResults.push((await execute(page, "update_lost_report_draft", {
      reportId, expectedVersion: 1, patch: { color: "black" },
      idempotencyKey: "native-update-0000001",
    })).raw);
    await page.locator(".workspace-header").getByText(/revision 2/i).waitFor();
    html.push(await page.content());

    await page.getByRole("button", { name: "Publish report manually" }).click();
    const publishedTools = await expectTools(page, "PUBLISHED report", ["find_candidate_matches", "list_my_reports"]);
    const found = await execute(page, "find_candidate_matches", { reportId, limit: 1 });
    rawResults.push(found.raw);
    const foundData = found.parsed.data as { reportVersion: number; candidates: Array<{ candidateHandle: string }> };
    if (!foundData.candidates[0]) throw new Error("Native find returned no candidate");
    await expectTools(page, "PUBLISHED with candidates", [
      "find_candidate_matches", "list_my_reports", "stage_claim_candidate",
    ]);

    const staged = await execute(page, "stage_claim_candidate", {
      reportId,
      candidateHandle: foundData.candidates[0].candidateHandle,
      expectedVersion: foundData.reportVersion,
      idempotencyKey: "native-stage-00000001",
    });
    rawResults.push(staged.raw);
    if (typeof staged.parsed.nextPath !== "string") throw new Error("Invalid stage result");
    await page.waitForURL(`${origin}${staged.parsed.nextPath}`);
    await page.getByRole("heading", { name: "Evidence checkpoint" }).waitFor();
    const claimId = (staged.parsed.data as Record<string, unknown>).claimId as string;
    await expectTools(page, "EVIDENCE_REQUIRED checkpoint", ["get_claim_status"]);
    rawResults.push((await execute(page, "get_claim_status", { claimId })).raw);
    const runtimeEvidenceCanary = createEvidenceTransportCanary();
    const evidenceRequest = page.waitForRequest((request) => request.url().endsWith("/evidence"));
    const evidenceResponse = page.waitForResponse((response) => response.url().endsWith("/evidence"));
    await page.getByLabel("Private evidence · unique mark").fill(runtimeEvidenceCanary);
    await page.getByRole("button", { name: "Submit private evidence" }).click();
    const wrongEvidenceRequest = await evidenceRequest;
    requireSingleTransportOccurrence({ label: "evidence request", url: wrongEvidenceRequest.url(),
      body: wrongEvidenceRequest.postData(), secret: runtimeEvidenceCanary });
    if (!(await evidenceResponse).ok()) throw new Error("Runtime evidence canary request failed");
    await page.locator(".checkpoint-ledger dd").getByText("1", { exact: true }).waitFor();
    html.push(await page.content());
    const evidenceBrowserState = await page.evaluate(() => JSON.stringify({ history: history.state, localStorage: Object.entries(localStorage), sessionStorage: Object.entries(sessionStorage) }));
    const evidence = readPrivateEvidenceSeedForTest(0);
    await page.getByLabel("Private evidence · unique mark").fill(evidence.unique_mark);
    await page.getByLabel("Private evidence · contents or accessory").fill(evidence.contents_or_accessory);
    await page.getByRole("button", { name: "Submit private evidence" }).click();
    await page.getByRole("heading", { name: "Waiting for Staff review" }).waitFor();
    await expectTools(page, "UNDER_REVIEW Claimant", ["get_claim_status"]);
    html.push(await page.content());
    await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
    await page.getByRole("button", { name: "Switch to Staff role" }).click();
    await page.getByRole("link", { name: "Open Staff review desk" }).click();
    await expectTools(page, "Staff queue", ["list_pending_claims"]);
    rawResults.push((await execute(page, "list_pending_claims", { limit: 3 })).raw);
    await page.goto(`${origin}/staff/claims/${claimId}`);
    await expectTools(page, "Staff UNDER_REVIEW claim", ["get_claim_review_summary", "get_claim_status"]);
    rawResults.push((await execute(page, "get_claim_review_summary", { claimId })).raw);
    await page.getByRole("button", { name: "Approve claim" }).click();
    await page.locator(".status-stamp").getByText("APPROVED").waitFor();
    await expectTools(page, "Staff APPROVED claim", ["get_claim_review_summary", "get_claim_status"]);

    await page.goto(origin);
    await page.getByRole("button", { name: "Switch to Claimant role" }).click();
    await page.goto(`${origin}/claimant/claims/${claimId}`);
    await expectTools(page, "Claimant APPROVED claim", ["get_claim_status", "get_pickup_instructions"]);
    rawResults.push((await execute(page, "get_pickup_instructions", { claimId })).raw);
    const issueResponse = page.waitForResponse((response) => response.url().endsWith("/pickup-pass/issue"));
    await page.getByRole("button", { name: "Generate pickup pass" }).click();
    const issued = await issueResponse;
    const issueText = await issued.text();
    const pickupToken = (JSON.parse(issueText) as { token: string }).token;
    requireSingleTransportOccurrence({ label: "issue response", url: issued.url(),
      body: issueText, secret: pickupToken });

    await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
    await page.getByRole("button", { name: "Switch to Staff role" }).click();
    await page.goto(`${origin}/staff/claims/${claimId}`);
    await expectTools(page, "Staff PICKUP_READY claim", ["get_claim_review_summary", "get_claim_status"]);
    await page.getByLabel("One-time pickup credential").fill(pickupToken);
    const handoffRequest = page.waitForRequest((request) => request.url().endsWith("/handoff"));
    await page.getByRole("button", { name: "Confirm atomic handoff" }).click();
    const handed = await handoffRequest;
    requireSingleTransportOccurrence({ label: "handoff request", url: handed.url(),
      body: handed.postData(), secret: pickupToken });
    await page.locator(".status-stamp").getByText("COLLECTED").waitFor();
    await expectTools(page, "Staff COLLECTED claim", ["get_claim_status"]);
    rawResults.push((await execute(page, "get_claim_status", { claimId })).raw);
    html.push(await page.content());
    const activity = await page.locator(".agent-activity").innerText();
    await page.goto(origin);
    await expectTools(page, "Home teardown", []);
    const browserState = await page.evaluate(() => JSON.stringify({
      history: history.state,
      localStorage: Object.entries(localStorage),
      sessionStorage: Object.entries(sessionStorage),
    }));

    const database = new Database(databasePath, { readonly: true });
    const internalIds = (database.prepare("SELECT id FROM found_items").all() as Array<{ id: string }>).map((row) => row.id);
    database.close();
    const inspected = JSON.stringify({ rawResults, html, activity, clientLogs, serverLogs, evidenceBrowserState, browserState });
    forbidRuntimeSecrets(inspected, [runtimeEvidenceCanary, pickupToken], runtimeEvidenceCanary);
    for (const id of internalIds) if (inspected.includes(id)) throw new Error("Internal inventory identity escaped");
    if (/inventoryItemId|catalogVersion|foundAt|\"score\"|csrfToken|cookie|stack/i.test(JSON.stringify(rawResults))) {
      throw new Error("Forbidden field escaped through native tool results");
    }
    if (workspace.some((tool) => typeof tool.annotations?.readOnlyHint !== "boolean" || typeof tool.annotations?.untrustedContentHint !== "boolean")) {
      throw new Error("Native descriptors lost explicit annotations");
    }
    if (publishedTools.map((tool) => tool.name).join(",") !== "find_candidate_matches,list_my_reports") {
      throw new Error("Native lexical tool ordering changed");
    }
    const expectedExecuted = [
      "create_lost_report_draft", "find_candidate_matches", "get_claim_review_summary",
      "get_claim_status", "get_pickup_instructions", "list_my_reports",
      "list_pending_claims", "stage_claim_candidate", "update_lost_report_draft",
    ];
    if (JSON.stringify([...executedTools].sort()) !== JSON.stringify(expectedExecuted)) {
      throw new Error(`Native nine-tool execution incomplete: ${JSON.stringify([...executedTools].sort())}`);
    }

    console.log(JSON.stringify({
      checkedAt: new Date().toISOString(),
      browserVersion: browser.version(),
      flag: "--enable-features=WebMCPTesting",
      signatures: {
        registerTool: "registerTool(tool, { signal }) -> Promise<void>",
        getTools: "getTools() -> Promise<descriptor[]>; inputSchema JSON string",
        executeTool: "executeTool(descriptor, JSON.stringify(input)) -> Promise<string|null>",
      },
      phases,
      executedTools: [...executedTools].sort(),
      writes: {
        createNonNullJsonString: true,
        updateNonNullJsonString: true,
        stageNonNullJsonString: true,
      },
      navigation: "same-document Next navigation reached both nextPath values",
      teardown: "left Claimant pages; native getTools returned []",
      isolation: "fresh temporary SQLite database and fresh demo instance; deleted after run",
      scans: "tool/HTML/activity/log/storage/history surfaces excluded internal IDs and runtime evidence/pickup canaries",
    }, null, 2));
  } finally {
    await cleanupNativeRun(browser, server, directory);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
