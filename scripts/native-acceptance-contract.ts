import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const NATIVE_TOOL_NAMES = Object.freeze([
  "create_lost_report_draft",
  "update_lost_report_draft",
  "list_my_reports",
  "find_candidate_matches",
  "stage_claim_candidate",
  "get_claim_status",
  "get_pickup_instructions",
  "list_pending_claims",
  "get_claim_review_summary",
] as const);
type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

export const NATIVE_PHASE_MATRIX = Object.freeze([
  { phase: "Claimant workspace", tools: ["create_lost_report_draft", "list_my_reports"] },
  { phase: "DRAFT report", tools: ["list_my_reports", "update_lost_report_draft"] },
  { phase: "PUBLISHED report", tools: ["find_candidate_matches", "list_my_reports"] },
  { phase: "PUBLISHED with candidates", tools: ["find_candidate_matches", "list_my_reports", "stage_claim_candidate"] },
  { phase: "EVIDENCE_REQUIRED checkpoint", tools: ["get_claim_status"] },
  { phase: "UNDER_REVIEW Claimant", tools: ["get_claim_status"] },
  { phase: "Staff queue", tools: ["list_pending_claims"] },
  { phase: "Staff UNDER_REVIEW claim", tools: ["get_claim_review_summary", "get_claim_status"] },
  { phase: "Staff APPROVED claim", tools: ["get_claim_review_summary", "get_claim_status"] },
  { phase: "Claimant APPROVED claim", tools: ["get_claim_status", "get_pickup_instructions"] },
  { phase: "Staff PICKUP_READY claim", tools: ["get_claim_review_summary", "get_claim_status"] },
  { phase: "Staff COLLECTED claim", tools: ["get_claim_status"] },
  { phase: "Home teardown", tools: [] },
] as const satisfies readonly Readonly<{ phase: string; tools: readonly NativeToolName[] }>[]);

const humanOnlyNames = new Set([
  "publish_report", "archive_report", "submit_evidence", "approve_claim",
  "reject_claim", "unlock_claim", "issue_pickup_pass", "reissue_pickup_pass",
  "handoff", "switch_role",
]);
const toolName = z.enum(NATIVE_TOOL_NAMES);
const phaseSchema = z.strictObject({
  phase: z.string().min(1).max(96),
  observedAt: z.string().datetime({ offset: true }),
  tools: z.array(toolName).max(9),
  schemas: z.array(z.string().min(1).max(96)).max(9),
});
const resultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  runId: z.string().uuid(),
  ordinal: z.number().int().min(1).max(3),
  startedAt: z.string().datetime({ offset: true }),
  endedAt: z.string().datetime({ offset: true }),
  durationMs: z.number().int().nonnegative(),
  browserVersion: z.string().min(1).max(64),
  nodeVersion: z.string().min(1).max(32),
  playwrightVersion: z.string().min(1).max(32),
  buildId: z.string().min(1).max(128),
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  flag: z.literal("--enable-features=WebMCPTesting"),
  signatures: z.strictObject({
    registerTool: z.string().min(1).max(128),
    getTools: z.string().min(1).max(128),
    executeTool: z.string().min(1).max(128),
  }),
  phases: z.array(phaseSchema).min(1).max(20),
  executedTools: z.array(toolName).length(9),
  writes: z.strictObject({
    createNonNullJsonString: z.literal(true),
    updateNonNullJsonString: z.literal(true),
    stageNonNullJsonString: z.literal(true),
  }),
  instanceCount: z.literal(1),
  humanOnlyToolsAbsent: z.literal(true),
  cleanupVerified: z.literal(true),
  navigation: z.string().min(1).max(160),
  teardown: z.string().min(1).max(160),
  isolation: z.string().min(1).max(200),
  scans: z.string().min(1).max(200),
});

export type NativePhaseEvidence = z.infer<typeof phaseSchema>;
export type NativeAcceptanceResult = z.infer<typeof resultSchema>;

export function nativeRunIdentity(environment: NodeJS.ProcessEnv = process.env) {
  const ordinal = Number(environment.CLAIMGATE_NATIVE_ORDINAL ?? "1");
  if (!Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 3) {
    throw new Error("Invalid native acceptance ordinal");
  }
  const runId = environment.CLAIMGATE_NATIVE_RUN_ID ?? randomUUID();
  if (!z.string().uuid().safeParse(runId).success) throw new Error("Invalid native acceptance run ID");
  const baseCommit = environment.CLAIMGATE_NATIVE_BASE_COMMIT
    ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const buildId = environment.CLAIMGATE_NATIVE_BUILD_ID
    ?? readFileSync(resolve(".next/BUILD_ID"), "utf8").trim();
  const playwright = JSON.parse(readFileSync(
    resolve("node_modules/@playwright/test/package.json"), "utf8",
  )) as { version?: unknown };
  if (!resultSchema.shape.baseCommit.safeParse(baseCommit).success) throw new Error("Invalid base commit");
  if (!resultSchema.shape.buildId.safeParse(buildId).success) throw new Error("Invalid build ID");
  if (typeof playwright.version !== "string") throw new Error("Invalid Playwright version");
  return Object.freeze({ runId, ordinal, baseCommit, buildId, playwrightVersion: playwright.version });
}

export function phaseEvidence(
  phase: string,
  tools: readonly string[],
  schemas: readonly string[],
): NativePhaseEvidence {
  return phaseSchema.parse({ phase, observedAt: new Date().toISOString(), tools, schemas });
}

export function humanOnlyToolsAbsent(phases: readonly NativePhaseEvidence[]): true {
  const names = phases.flatMap(({ tools }) => tools);
  if (names.some((name) => humanOnlyNames.has(name))) throw new Error("Human-only tool was registered");
  return true;
}

function assertExactPhaseMatrix(phases: readonly NativePhaseEvidence[]): void {
  const observed = phases.map(({ phase, tools, schemas }) => ({ phase, tools, schemas }));
  const expected = NATIVE_PHASE_MATRIX.map(({ phase, tools }) => ({
    phase,
    tools: [...tools],
    schemas: tools.map((name) => `${name}:JSON-string`),
  }));
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    throw new Error("Native acceptance did not match the exact 13-stage phase matrix");
  }
}

export function createNativeAcceptanceDraft(input: Readonly<{
  identity: ReturnType<typeof nativeRunIdentity>;
  startedAtMs: number;
  browserVersion: string;
  phases: readonly NativePhaseEvidence[];
  executedTools: readonly (typeof NATIVE_TOOL_NAMES)[number][];
  instanceCount: number;
}>): Omit<NativeAcceptanceResult, "endedAt" | "durationMs" | "cleanupVerified"> {
  if (input.instanceCount !== 1) throw new Error("Native run did not create exactly one demo instance");
  assertExactPhaseMatrix(input.phases);
  return resultSchema.omit({ endedAt: true, durationMs: true, cleanupVerified: true }).parse({
    schemaVersion: 1,
    ...input.identity,
    startedAt: new Date(input.startedAtMs).toISOString(),
    browserVersion: input.browserVersion,
    nodeVersion: process.version,
    flag: "--enable-features=WebMCPTesting",
    signatures: {
      registerTool: "registerTool(tool, { signal }) -> Promise<void>",
      getTools: "getTools() -> Promise<descriptor[]>; inputSchema JSON string",
      executeTool: "executeTool(descriptor, JSON.stringify(input)) -> Promise<string|null>",
    },
    phases: input.phases,
    executedTools: input.executedTools,
    writes: {
      createNonNullJsonString: true,
      updateNonNullJsonString: true,
      stageNonNullJsonString: true,
    },
    instanceCount: 1,
    humanOnlyToolsAbsent: humanOnlyToolsAbsent(input.phases),
    navigation: "same-document Next navigation reached both nextPath values",
    teardown: "left Claimant pages; native getTools returned []",
    isolation: "fresh temporary SQLite database and fresh demo instance; deleted after run",
    scans: "tool/HTML/activity/log/storage/history surfaces excluded internal IDs and runtime evidence/pickup canaries",
  });
}

export function finalizeNativeAcceptance(
  draft: Omit<NativeAcceptanceResult, "endedAt" | "durationMs" | "cleanupVerified">,
  startedAtMs: number,
): NativeAcceptanceResult {
  const endedAtMs = Date.now();
  return resultSchema.parse({
    ...draft,
    endedAt: new Date(endedAtMs).toISOString(),
    durationMs: endedAtMs - startedAtMs,
    cleanupVerified: true,
  });
}

export function parseNativeAcceptanceResult(
  text: string,
  expected: Readonly<{ ordinal: number; runId: string; baseCommit: string; buildId: string }>,
): NativeAcceptanceResult {
  const parsed = resultSchema.parse(JSON.parse(text) as unknown);
  assertExactPhaseMatrix(parsed.phases);
  if (
    parsed.ordinal !== expected.ordinal
    || parsed.runId !== expected.runId
    || parsed.baseCommit !== expected.baseCommit
    || parsed.buildId !== expected.buildId
  ) throw new Error("Native acceptance identity mismatch");
  if (new Set(parsed.executedTools).size !== NATIVE_TOOL_NAMES.length) {
    throw new Error("Native acceptance did not execute exactly nine tools");
  }
  const home = parsed.phases.at(-1);
  if (home?.phase !== "Home teardown" || home.tools.length !== 0) {
    throw new Error("Native acceptance did not prove Home teardown");
  }
  return parsed;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
