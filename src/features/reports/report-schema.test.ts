import { describe, expect, it } from "vitest";
import { parseCreateReportForm, parseUpdateReportForm } from "./report-schema";

const createEntries = (overrides: Record<string, string> = {}) => Object.entries({
  category: "earbuds",
  timeFrom: "2026-08-25T17:00:00.000Z",
  timeTo: "2026-08-25T19:00:00.000Z",
  area: "library",
  color: "black",
  publicTags: '["wireless","charging-case"]',
  publicDescription: "Black wireless earbud case.",
  idempotencyKey: "idem-create-00000001",
  ...overrides,
}) as ReadonlyArray<readonly [string, string]>;

describe("strict report form schemas", () => {
  it("normalizes a bounded create DTO without coercion", () => {
    expect(parseCreateReportForm(createEntries({ category: "  ＥＡＲＢＵＤＳ  " }))).toEqual({
      category: "earbuds",
      timeWindow: {
        from: "2026-08-25T17:00:00.000Z",
        to: "2026-08-25T19:00:00.000Z",
      },
      area: "library",
      color: "black",
      publicTags: ["wireless", "charging-case"],
      publicDescription: "Black wireless earbud case.",
      idempotencyKey: "idem-create-00000001",
    });
  });

  it.each([
    [[...createEntries(), ["extra", "x"]] as ReadonlyArray<readonly [string, string]>],
    [[...createEntries(), ["area", "park"]] as ReadonlyArray<readonly [string, string]>],
    [createEntries({ publicTags: '["wireless","WIRELESS"]' })],
    [createEntries({ publicTags: '{"0":"wireless"}' })],
    [createEntries({ timeFrom: "2026-08-25T20:00:00.000Z" })],
    [createEntries({ timeFrom: "1756141200000" })],
    [createEntries({ publicDescription: "bad\ud800text" })],
    [createEntries({ publicDescription: "x".repeat(257) })],
  ])("rejects extras, duplicates, coercion, invalid tags/times/Unicode and oversized text", (entries) => {
    expect(() => parseCreateReportForm(entries)).toThrow(
      expect.objectContaining({ code: "VALIDATION_FAILED" }),
    );
  });

  it("rejects evidence-shaped fields", () => {
    expect(() => parseCreateReportForm([
      ...createEntries(),
      ["uniqueMark", "secret"],
    ])).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("accepts a non-empty strict update patch and canonical expected version", () => {
    expect(parseUpdateReportForm([
      ["expectedVersion", "2"],
      ["area", " Student Center "],
      ["idempotencyKey", "idem-update-00000001"],
    ])).toEqual({
      expectedVersion: 2,
      patch: { area: "student center" },
      idempotencyKey: "idem-update-00000001",
    });
  });

  it.each([
    [[ ["expectedVersion", "2"], ["idempotencyKey", "idem-update-00000001"] ]],
    [[ ["expectedVersion", "02"], ["area", "library"], ["idempotencyKey", "idem-update-00000001"] ]],
    [[ ["expectedVersion", "2.0"], ["area", "library"], ["idempotencyKey", "idem-update-00000001"] ]],
    [[ ["expectedVersion", "2"], ["area", "library"], ["area", "park"], ["idempotencyKey", "idem-update-00000001"] ]],
    [[ ["expectedVersion", "2"], ["status", "PUBLISHED"], ["idempotencyKey", "idem-update-00000001"] ]],
  ])("rejects empty/coerced/duplicate/extra update data", (entries) => {
    expect(() => parseUpdateReportForm(entries as unknown as ReadonlyArray<readonly [string, string]>))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
});
