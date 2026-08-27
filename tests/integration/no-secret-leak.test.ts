import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createActivityStore } from "@/features/webmcp/activity-store";
import { createClaimGateTools, type ClaimGateToolName } from "@/features/webmcp/tool-contracts";
import { createToolExecutor } from "@/features/webmcp/tool-executor";
import { normalizeEvidence } from "@/features/evidence/normalize-evidence";
import {
  allDatabaseRows,
  capture,
  containsExact,
  csrfToken,
  postRequest,
  readRequest,
  setupLeakFlow,
} from "./no-secret-leak-harness";

afterEach(() => vi.restoreAllMocks());

function parsed<T>(captureValue: Awaited<ReturnType<typeof capture>>): T {
  return JSON.parse(captureValue.body) as T;
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("whole-system distinctive secret canaries", () => {
  it("allows raw evidence and pickup credential only on their exact transient transports", async () => {
    const value = setupLeakFlow();
    const consoleSpies = [
      vi.spyOn(console, "log").mockImplementation(() => undefined),
      vi.spyOn(console, "info").mockImplementation(() => undefined),
      vi.spyOn(console, "warn").mockImplementation(() => undefined),
      vi.spyOn(console, "error").mockImplementation(() => undefined),
      vi.spyOn(console, "debug").mockImplementation(() => undefined),
    ];
    const rawEvidence = `CG10Evidence${randomUUID().replaceAll("-", "")}`;
    const evidenceVariants = [rawEvidence, normalizeEvidence(rawEvidence)];
    const csrfValues: string[] = [];
    const apiResponses: Array<{ label: string; value: Awaited<ReturnType<typeof capture>> }> = [];
    const webMcpOutputs: unknown[] = [];
    const activity = createActivityStore({ now: () => NOW_FOR_ACTIVITY });
    const claimId = value.claim.claimId;

    const post = async (
      label: string,
      routeKey: Parameters<typeof csrfToken>[2],
      path: string,
      signed: typeof value.claimant,
      body: string,
      handler: (request: Request) => Promise<Response>,
    ) => {
      const csrf = csrfToken(value, signed, routeKey, path);
      csrfValues.push(csrf);
      const request = postRequest(path, signed.token, csrf, body);
      const result = await capture(await handler(request));
      apiResponses.push({ label, value: result });
      return { body, request, result };
    };

    const readFetcher = (signed: typeof value.claimant): typeof fetch => async (input) => {
      const path = String(input);
      const request = readRequest(path, signed.token);
      const response = path.endsWith("/pickup-instructions")
        ? await value.pickup(request)
        : path.startsWith("/api/staff/claims/")
          ? await value.review(request)
          : await value.status(request);
      apiResponses.push({ label: `tool-read:${path}`, value: await capture(response.clone()) });
      return response;
    };
    const claimantTools = createClaimGateTools(createToolExecutor({ fetcher: readFetcher(value.claimant) }));
    const staffTools = createClaimGateTools(createToolExecutor({ fetcher: readFetcher(value.staff) }));
    const runTool = async (
      name: ClaimGateToolName,
      tool: WebMCPTool,
      input: Record<string, unknown>,
    ) => {
      const finish = activity.begin(name);
      const result = await tool.execute(input);
      expect(result).toMatchObject({ ok: true });
      finish({ success: true, stateChange: "No page change" });
      webMcpOutputs.push(result);
    };

    try {
      const evidencePath = `/api/claims/${claimId}/evidence`;
      const wrongBody = new URLSearchParams({
        expectedVersion: "1",
        idempotencyKey: "leak-evidence-wrong-001",
        unique_mark: rawEvidence,
      }).toString();
      const wrong = await post(
        "evidence-wrong", "api.claims.evidence", evidencePath,
        value.claimant, wrongBody, value.evidence,
      );
      expect(wrong.body).toContain(rawEvidence);
      expect(wrong.request.url).not.toContain(rawEvidence);
      const wrongAck = parsed<{ version: number }>(wrong.result);

      const correctBody = new URLSearchParams({
        expectedVersion: String(wrongAck.version),
        idempotencyKey: "leak-evidence-correct-01",
        ...value.correctEvidence,
      }).toString();
      const eligible = await post(
        "evidence-correct", "api.claims.evidence", evidencePath,
        value.claimant, correctBody, value.evidence,
      );
      const eligibleAck = parsed<{ version: number; status: string }>(eligible.result);
      expect(eligibleAck.status).toBe("UNDER_REVIEW");
      await runTool(
        "get_claim_review_summary",
        staffTools.get_claim_review_summary,
        { claimId },
      );

      const review = value.testDatabase.repository.getStaffClaimReview(
        value.instance.demoInstanceId, claimId,
      );
      const approvePath = `/api/staff/claims/${claimId}/approve`;
      const approved = await post(
        "approve", "api.staff.claims.approve", approvePath, value.staff,
        new URLSearchParams({
          expectedClaimVersion: String(eligibleAck.version),
          expectedItemVersion: String(review.item.itemVersion),
          idempotencyKey: "leak-approve-00000001",
        }).toString(),
        value.approve,
      );
      const approvedAck = parsed<{ version: number; status: string }>(approved.result);
      expect(approvedAck.status).toBe("APPROVED");
      await runTool(
        "get_pickup_instructions",
        claimantTools.get_pickup_instructions,
        { claimId },
      );

      const issuePath = `/api/claims/${claimId}/pickup-pass/issue`;
      const issued = await post(
        "issue", "api.claims.pickup.issue", issuePath, value.claimant,
        new URLSearchParams({
          expectedClaimVersion: String(approvedAck.version),
          idempotencyKey: "leak-issue-0000000001",
        }).toString(),
        value.issue,
      );
      const issueAck = parsed<{ token: string; generation: number }>(issued.result);
      const pickupToken = issueAck.token;
      expect(count(issued.result.body, pickupToken)).toBe(1);
      expect(containsExact([issued.result.headers, issued.result.url], pickupToken)).toBe(false);
      await runTool(
        "get_pickup_instructions",
        claimantTools.get_pickup_instructions,
        { claimId },
      );

      const ready = value.testDatabase.repository.getStaffClaimReview(
        value.instance.demoInstanceId, claimId,
      );
      const handoffPath = `/api/staff/claims/${claimId}/handoff`;
      const handoffBody = new URLSearchParams({
        token: pickupToken,
        expectedClaimVersion: String(ready.claim.version),
        expectedItemVersion: String(ready.item.itemVersion),
        expectedReportVersion: String(ready.report.version),
        expectedGeneration: String(issueAck.generation),
        idempotencyKey: "leak-handoff-0000001",
      }).toString();
      const handed = await post(
        "handoff", "api.staff.claims.handoff", handoffPath,
        value.staff, handoffBody, value.handoff,
      );
      expect(count(handed.body, pickupToken)).toBe(1);
      expect(parsed<{ claimStatus: string }>(handed.result).claimStatus).toBe("COLLECTED");
      await runTool("get_claim_status", staffTools.get_claim_status, { claimId });

      const repository = value.testDatabase.repository;
      const database = value.testDatabase.database;
      const durable = {
        tables: allDatabaseRows(database),
        audit: repository.listAuditEvents(value.instance.demoInstanceId),
        timeline: repository.listClaimTimeline(value.instance.demoInstanceId, claimId, 50),
        idempotency: database.prepare("SELECT * FROM idempotency_records").all(),
      };
      const logs = consoleSpies.map((spy) => spy.mock.calls);
      const activityEntries = activity.getSnapshot();
      const allExternal = { apiResponses, webMcpOutputs, activityEntries, logs };
      for (const canary of evidenceVariants) {
        expect(containsExact([allExternal, durable], canary)).toBe(false);
      }
      const withoutIssue = apiResponses.filter(({ label }) => label !== "issue");
      expect(containsExact([
        withoutIssue, durable, webMcpOutputs, activityEntries, logs,
      ], pickupToken)).toBe(false);
      for (const transportSecret of [
        value.claimant.token, value.staff.token, ...csrfValues,
      ]) expect(containsExact([allExternal, durable], transportSecret)).toBe(false);
      expect(containsExact(allExternal, value.item.inventoryItemId)).toBe(false);
    } finally {
      value.testDatabase.close();
    }
  });
});

const NOW_FOR_ACTIVITY = Date.UTC(2026, 7, 27, 12, 30);
