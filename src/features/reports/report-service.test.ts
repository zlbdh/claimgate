import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeyring } from "@/server/security/keyring";
import { createTestDatabase, type TestDatabase } from "@/server/db/test-harness";
import { createReportService } from "./report-service";

const NOW = Date.UTC(2026, 7, 26, 12);
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup() {
  testDatabase = createTestDatabase(NOW);
  const instance = testDatabase.repository.createDemoInstance();
  const service = createReportService({
    repository: testDatabase.repository,
    keyring: createKeyring(Buffer.alloc(32, 7).toString("base64")),
    now: () => NOW,
  });
  const context = {
    demoInstanceId: instance.demoInstanceId,
    actorId: "claimant-demo" as const,
    sessionExpiresAt: instance.expiresAtMs,
  };
  return { instance, service, context };
}

const draftInput = (idempotencyKey = "idem-create-00000001") => ({
  category: "earbuds",
  timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
  area: "library",
  color: "black",
  publicTags: ["wireless", "charging-case"],
  publicDescription: "Black wireless earbud case.",
  idempotencyKey,
});

describe("ReportService business boundary", () => {
  it("creates one owner DRAFT and replays the same canonical idempotency input", () => {
    const { service, context } = setup();
    const first = service.createDraft(context, draftInput());
    const replay = service.createDraft(context, draftInput());
    expect(replay).toEqual(first);
    expect(first).toMatchObject({ status: "DRAFT", version: 1, nextPath: `/claimant/reports/${first.reportId}` });
    expect(testDatabase!.repository.listLostReports(context.demoInstanceId)).toHaveLength(1);
    expect(testDatabase!.repository.listAuditEvents(context.demoInstanceId)
      .filter((event) => event.action === "REPORT_CREATED")).toHaveLength(1);
  });

  it("rejects same key with a different canonical fingerprint", () => {
    const { service, context } = setup();
    service.createDraft(context, draftInput());
    expect(() => service.createDraft(context, { ...draftInput(), color: "navy" }))
      .toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });

  it("returns the original create ack after later report mutations", () => {
    const { service, context } = setup();
    const first = service.createDraft(context, draftInput());
    service.updateDraft(context, first.reportId, {
      expectedVersion: 1,
      patch: { color: "navy" },
      idempotencyKey: "idem-update-00000009",
    });
    expect(service.createDraft(context, draftInput())).toEqual(first);
  });

  it("updates only the owner's DRAFT at the expected version and leaves stale attempts inert", () => {
    const { service, context } = setup();
    const draft = service.createDraft(context, draftInput());
    const updated = service.updateDraft(context, draft.reportId, {
      expectedVersion: 1,
      patch: { area: "student-center" },
      idempotencyKey: "idem-update-00000001",
    });
    expect(updated).toMatchObject({ reportId: draft.reportId, version: 2, status: "DRAFT" });
    expect(() => service.updateDraft(context, draft.reportId, {
      expectedVersion: 1,
      patch: { color: "navy" },
      idempotencyKey: "idem-update-00000002",
    })).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
  });

  it("manually publishes, owner-lists, and archives without exposing another context", () => {
    const { service, context } = setup();
    const draft = service.createDraft(context, draftInput());
    const published = service.publish(context, draft.reportId, 1);
    expect(published).toMatchObject({ status: "PUBLISHED", version: 2 });
    expect(service.listOwned(context)).toHaveLength(1);
    expect(() => service.listOwned({ ...context, actorId: "staff-demo" }))
      .toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    expect(service.archive(context, draft.reportId, 2)).toMatchObject({ status: "ARCHIVED", version: 3 });
  });

  it("bounds the owner report index response", () => {
    const { service, context } = setup();
    for (let index = 0; index < 51; index += 1) {
      service.createDraft(context, draftInput(`idem-create-${String(index).padStart(8, "0")}`));
    }
    expect(service.listOwned(context)).toHaveLength(50);
  });

  it("matches only AVAILABLE inventory into stable Top 3 browser DTOs", () => {
    const { service, context } = setup();
    const draft = service.createDraft(context, draftInput());
    service.publish(context, draft.reportId, 1);
    const hiddenId = testDatabase!.repository.listServerInternalFoundItems(context.demoInstanceId)[0]!.inventoryItemId;
    testDatabase!.database.prepare("UPDATE found_items SET status = 'HELD' WHERE demo_instance_id = ? AND id = ?")
      .run(context.demoInstanceId, hiddenId);
    const result = service.findCandidates(context, draft.reportId, 3);
    expect(result.candidates.length).toBeLessThanOrEqual(3);
    expect(result.candidates.map((candidate) => Object.keys(candidate).sort())).toEqual(
      result.candidates.map(() => [
        "area", "candidateHandle", "category", "color", "confidence", "expiresAt", "reasons", "timeBand",
      ].sort()),
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(hiddenId);
    for (const forbidden of ["inventoryItemId", "candidateId", "foundAt", "score", "publicTags", "publicDescription", "catalogVersion", "reportVersion"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("requires owner PUBLISHED state for matching and stales handles after catalog/report changes", () => {
    const { service, context } = setup();
    const draft = service.createDraft(context, draftInput());
    expect(() => service.findCandidates(context, draft.reportId, 3))
      .toThrow(expect.objectContaining({ code: "INVALID_STATE_TRANSITION" }));
    service.publish(context, draft.reportId, 1);
    const candidate = service.findCandidates(context, draft.reportId, 3).candidates[0]!;
    const resolved = service.resolveCandidate(context, draft.reportId, candidate.candidateHandle);
    expect(resolved).toMatch(/^test-/);
    testDatabase!.database.prepare("UPDATE demo_instances SET catalog_version = catalog_version + 1 WHERE id = ?")
      .run(context.demoInstanceId);
    expect(() => service.resolveCandidate(context, draft.reportId, candidate.candidateHandle))
      .toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
  });

  it("returns a bounded refinement message when no candidate reaches the category gate", () => {
    const { service, context } = setup();
    const draft = service.createDraft(context, { ...draftInput(), category: "wallet" });
    service.publish(context, draft.reportId, 1);
    expect(service.findCandidates(context, draft.reportId, 3)).toEqual({
      candidates: [],
      message: "No close candidates yet. Refine the public time window, area, color, or descriptors.",
    });
  });

  it("invalidates a handle after a public item mutation, availability change, or report archive", () => {
    const { service, context } = setup();
    const draft = service.createDraft(context, draftInput());
    service.publish(context, draft.reportId, 1);

    const first = service.findCandidates(context, draft.reportId, 3).candidates[0]!;
    const inventoryItemId = service.resolveCandidate(context, draft.reportId, first.candidateHandle);
    const item = testDatabase!.repository.listServerInternalFoundItems(context.demoInstanceId)
      .find((entry) => entry.inventoryItemId === inventoryItemId)!;
    testDatabase!.repository.updateFoundItem({
      demoInstanceId: context.demoInstanceId,
      inventoryItemId,
      expectedVersion: item.version,
      actorId: "staff-demo",
      patch: { color: item.color === "black" ? "navy" : "black" },
    });
    expect(() => service.resolveCandidate(context, draft.reportId, first.candidateHandle))
      .toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));

    const second = service.findCandidates(context, draft.reportId, 3).candidates[0]!;
    const secondId = service.resolveCandidate(context, draft.reportId, second.candidateHandle);
    testDatabase!.database.transaction(() => {
      testDatabase!.database.prepare("UPDATE found_items SET status = 'HELD' WHERE demo_instance_id = ? AND id = ?")
        .run(context.demoInstanceId, secondId);
      testDatabase!.database.prepare("UPDATE demo_instances SET catalog_version = catalog_version + 1 WHERE id = ?")
        .run(context.demoInstanceId);
    }).immediate();
    expect(() => service.resolveCandidate(context, draft.reportId, second.candidateHandle))
      .toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));

    const third = service.findCandidates(context, draft.reportId, 3).candidates[0]!;
    service.archive(context, draft.reportId, 2);
    expect(() => service.resolveCandidate(context, draft.reportId, third.candidateHandle))
      .toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
  });

  it("preflights malformed and expired handles before any report or inventory transaction", () => {
    const { service, context } = setup();
    const draft = service.createDraft(context, draftInput());
    const archived = service.createDraft(context, draftInput("idem-create-archived"));
    service.archive(context, archived.reportId, 1);
    const transaction = vi.spyOn(testDatabase!.repository, "withTransaction");
    const nowSeconds = Math.floor(NOW / 1_000);
    const expired = `cgch1.${nowSeconds - 900}.${nowSeconds}.${"A".repeat(43)}`;

    for (const reportId of ["missing-report", draft.reportId, archived.reportId]) {
      transaction.mockClear();
      expect(() => service.resolveCandidate(context, reportId, "bad"))
        .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
      expect(transaction).not.toHaveBeenCalled();
    }
    transaction.mockClear();
    expect(() => service.resolveCandidate(context, "missing-report", expired))
      .toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
    expect(transaction).not.toHaveBeenCalled();
  });

  it("reads the handle clock once, then snapshots a valid-shape tamper", () => {
    testDatabase = createTestDatabase(NOW);
    const instance = testDatabase.repository.createDemoInstance();
    const clock = vi.fn(() => NOW);
    const service = createReportService({
      repository: testDatabase.repository,
      keyring: createKeyring(Buffer.alloc(32, 7).toString("base64")),
      now: clock,
    });
    const context = {
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo" as const,
      sessionExpiresAt: instance.expiresAtMs,
    };
    const draft = service.createDraft(context, draftInput());
    service.publish(context, draft.reportId, 1);
    const candidate = service.findCandidates(context, draft.reportId, 1).candidates[0]!;
    const parts = candidate.candidateHandle.split(".");
    parts[3] = `${parts[3]![0] === "A" ? "B" : "A"}${parts[3]!.slice(1)}`;
    clock.mockClear();
    const transaction = vi.spyOn(testDatabase.repository, "withTransaction");

    expect(() => service.resolveCandidate(context, draft.reportId, parts.join(".")))
      .toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
    expect(clock).toHaveBeenCalledOnce();
    expect(transaction).toHaveBeenCalledOnce();
  });
});
