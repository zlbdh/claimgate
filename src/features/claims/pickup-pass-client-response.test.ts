import { describe, expect, it } from "vitest";
import {
  parseHandoffClientResponse,
  parsePickupIssuanceClientResponse,
} from "./pickup-pass-client-response";

const NOW = 1_000_000;
const TOKEN = "abcdefghijklmnopqrstuA";
const ISSUE_EXPECTED = {
  claimId: "claim-client",
  currentClaimVersion: 5,
  expectedGeneration: 1,
  now: NOW,
};
const ISSUED = {
  issuance: "ISSUED",
  claimId: "claim-client",
  status: "PICKUP_READY",
  claimVersion: 6,
  generation: 1,
  expiresAtMs: NOW + 60_000,
  token: TOKEN,
};
const ALREADY = {
  issuance: "ALREADY_ISSUED",
  claimId: "claim-client",
  status: "PICKUP_READY",
  claimVersion: 6,
  generation: 1,
  expiresAtMs: NOW + 60_000,
};

describe("strict pickup client response schemas", () => {
  it("accepts exact ISSUED and ALREADY_ISSUED acknowledgements", () => {
    expect(parsePickupIssuanceClientResponse(ISSUED, ISSUE_EXPECTED)).toEqual(ISSUED);
    expect(parsePickupIssuanceClientResponse(ALREADY, ISSUE_EXPECTED)).toEqual(ALREADY);
    expect(parsePickupIssuanceClientResponse({ ...ISSUED, expiresAtMs: NOW + 600_000 }, ISSUE_EXPECTED))
      .toMatchObject({ expiresAtMs: NOW + 600_000 });
  });

  it.each([
    { value: { ...ISSUED, expiresAtMs: NOW + 600_001 }, expected: ISSUE_EXPECTED },
    { value: { ...ISSUED, expiresAtMs: NOW + 365 * 24 * 60 * 60_000 }, expected: ISSUE_EXPECTED },
    { value: { ...ISSUED, expiresAtMs: NOW + 60_000 }, expected: { ...ISSUE_EXPECTED, now: 1.5 } },
    { value: { ...ISSUED, expiresAtMs: NOW + 60_000 }, expected: { ...ISSUE_EXPECTED, now: Number.NaN } },
  ])("rejects issuance outside a safe ten-minute clock boundary %#", ({ value, expected }) => {
    expect(() => parsePickupIssuanceClientResponse(value, expected)).toThrow();
  });

  it.each([
    { ...ISSUED, extra: true },
    { ...ISSUED, claimId: "other" },
    { ...ISSUED, status: "APPROVED" },
    { ...ISSUED, claimVersion: 5 },
    { ...ISSUED, generation: 2 },
    { ...ISSUED, expiresAtMs: NOW },
    { ...ISSUED, expiresAtMs: Number.MAX_SAFE_INTEGER },
    { ...ISSUED, token: `${TOKEN.slice(0, -1)}B` },
    { ...ALREADY, token: TOKEN },
    { ...ALREADY, extra: true },
    Object.assign(Object.create(null), ISSUED),
    [ISSUED],
  ])("rejects malformed issuance response %#", (value) => {
    expect(() => parsePickupIssuanceClientResponse(value, ISSUE_EXPECTED)).toThrow();
  });

  it("accepts exact collected handoff acknowledgements", () => {
    const expected = {
      claimId: "claim-client", currentClaimVersion: 6,
      currentItemVersion: 4, currentReportVersion: 3, expectedGeneration: 1,
    };
    for (const completion of ["COLLECTED", "ALREADY_COLLECTED"] as const) {
      expect(parseHandoffClientResponse({
        kind: "handoff_ack", claimId: "claim-client", completion,
        claimStatus: "COLLECTED", claimVersion: 7,
        itemStatus: "RETURNED", itemVersion: 5,
        reportStatus: "RESOLVED", reportVersion: 4, generation: 1,
      }, expected)).toMatchObject({ completion });
    }
  });

  it.each([
    { field: "claimId", value: "other" },
    { field: "completion", value: "DONE" },
    { field: "claimStatus", value: "PICKUP_READY" },
    { field: "claimVersion", value: 6 },
    { field: "itemStatus", value: "HELD" },
    { field: "itemVersion", value: 4 },
    { field: "reportStatus", value: "PUBLISHED" },
    { field: "reportVersion", value: 3 },
    { field: "generation", value: 2 },
    { field: "extra", value: true },
  ])("rejects malformed handoff $field", ({ field, value }) => {
    const ack: Record<string, unknown> = {
      kind: "handoff_ack", claimId: "claim-client", completion: "COLLECTED",
      claimStatus: "COLLECTED", claimVersion: 7,
      itemStatus: "RETURNED", itemVersion: 5,
      reportStatus: "RESOLVED", reportVersion: 4, generation: 1,
    };
    ack[field] = value;
    expect(() => parseHandoffClientResponse(ack, {
      claimId: "claim-client", currentClaimVersion: 6,
      currentItemVersion: 4, currentReportVersion: 3, expectedGeneration: 1,
    })).toThrow();
  });
});
