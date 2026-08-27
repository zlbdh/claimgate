import { describe, expect, it, vi } from "vitest";
import { createReportFingerprint, updateReportFingerprint } from "./report-fingerprint";
import { parseCreateReportForm, parseUpdateReportForm } from "./report-schema";
import {
  attachReportIntentKey,
  reportClientIntentFingerprint,
  type ReportIntentRef,
} from "./report-client-intent";

const PLACEHOLDER = "client-intent-placeholder-v1";

function createBody(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    category: "earbuds",
    timeFrom: "2026-08-25T17:00:00.000Z",
    timeTo: "2026-08-25T19:00:00.000Z",
    area: "library",
    color: "black",
    publicTags: '["wireless","charging-case"]',
    publicDescription: "Black wireless earbud case.",
    ...overrides,
  });
}

function updateBody(overrides: Record<string, string> = {}) {
  return new URLSearchParams({
    expectedVersion: "4",
    category: "earbuds",
    timeFrom: "2026-08-25T17:00:00.000Z",
    timeTo: "2026-08-25T19:00:00.000Z",
    area: "library",
    color: "black",
    publicTags: '["wireless","charging-case"]',
    publicDescription: "Black wireless earbud case.",
    ...overrides,
  });
}

function entriesWithPlaceholder(body: URLSearchParams): ReadonlyArray<readonly [string, string]> {
  return [...body.entries(), ["idempotencyKey", PLACEHOLDER] as const];
}

function serverCreateFingerprint(body: URLSearchParams) {
  return createReportFingerprint(parseCreateReportForm(entriesWithPlaceholder(body)));
}

function serverUpdateFingerprint(body: URLSearchParams, reportId = "report-public") {
  return updateReportFingerprint(reportId, parseUpdateReportForm(entriesWithPlaceholder(body)));
}

describe("canonical report client intent", () => {
  it.each([
    ["NFKC/token case/trim/dash/whitespace", createBody(), createBody({
      category: "  ＥＡＲＢＵＤＳ  ",
      area: "  LIBRARY  ",
      color: " BLACK ",
      publicTags: '["ＷＩＲＥＬＥＳＳ","charging–case"]',
      publicDescription: "  Black   wireless earbud case.  ",
    }), true],
    ["description case", createBody(), createBody({ publicDescription: "black wireless earbud case." }), false],
    ["tag order", createBody(), createBody({ publicTags: '["charging-case","wireless"]' }), false],
    ["business color", createBody(), createBody({ color: "navy" }), false],
  ])("matches the server create fingerprint iff canonical intent is equal: %s", (_name, left, right, equal) => {
    const clientLeft = reportClientIntentFingerprint(left, { kind: "create" });
    const clientRight = reportClientIntentFingerprint(right, { kind: "create" });
    expect(clientLeft).toBe(serverCreateFingerprint(left));
    expect(clientRight).toBe(serverCreateFingerprint(right));
    expect(clientLeft === clientRight).toBe(equal);
  });

  it("uses the exact update parser/fingerprint and binds trusted report ID", () => {
    const raw = updateBody({ category: " ＥＡＲＢＵＤＳ ", area: " LIBRARY " });
    expect(reportClientIntentFingerprint(raw, { kind: "update", reportId: "report-public" }))
      .toBe(serverUpdateFingerprint(raw));
    expect(reportClientIntentFingerprint(raw, { kind: "update", reportId: "report-other" }))
      .toBe(serverUpdateFingerprint(raw, "report-other"));
    expect(reportClientIntentFingerprint(raw, { kind: "update", reportId: "report-other" }))
      .not.toBe(reportClientIntentFingerprint(raw, { kind: "update", reportId: "report-public" }));
  });

  it.each([
    [{ kind: "create" } as const, new URLSearchParams({ category: "!!!" })],
    [{ kind: "update", reportId: "report-public" } as const, new URLSearchParams({ expectedVersion: "01" })],
  ])("invalid %s body does not allocate a key or mutate the retained intent", (context, body) => {
    const retained = { fingerprint: "retained", idempotencyKey: "retained-key-0001" };
    const ref: ReportIntentRef = { current: retained };
    const createKey = vi.fn(() => "new-real-key-0001");
    expect(() => attachReportIntentKey(body, context, ref, createKey))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    expect(ref.current).toBe(retained);
    expect(createKey).not.toHaveBeenCalled();
  });

  it("uses the placeholder only for parsing and never returns or fingerprints it", () => {
    const ref: ReportIntentRef = { current: undefined };
    const body = attachReportIntentKey(
      createBody(),
      { kind: "create" },
      ref,
      () => "real-client-key-0001",
    );
    expect(body.get("idempotencyKey")).toBe("real-client-key-0001");
    expect(body.toString()).not.toContain(PLACEHOLDER);
    expect(ref.current?.fingerprint).not.toContain(PLACEHOLDER);
  });
});
