import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { DomainError } from "@/shared/domain-error";
import { mintCandidateHandles, resolveCandidateHandle } from "./candidate-handle";

const NOW_MS = Date.UTC(2026, 7, 26, 12);
const KEY = Buffer.alloc(32, 41);
const base = {
  key: KEY,
  nowMs: NOW_MS,
  ceilingMs: NOW_MS + 20 * 60_000,
  demoInstanceId: "instance-public",
  reportId: "report-public",
  reportVersion: 2,
  catalogVersion: 4,
  inventoryItemIds: ["internal-seeded-A", "internal-seeded-B", "internal-seeded-C"],
};

describe("opaque candidate handles", () => {
  it("mints the exact cgch1 time/MAC wire shape without any identifier payload", () => {
    const handles = mintCandidateHandles(base);
    expect(handles).toHaveLength(3);
    expect(new Set(handles.map((handle) => handle.split(".").slice(1, 3).join("."))).size).toBe(1);
    for (const handle of handles) {
      expect(handle).toMatch(/^cgch1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.[A-Za-z0-9_-]{43}$/);
      expect(handle.split(".")).toHaveLength(4);
      expect(handle).not.toContain("internal-seeded");
      expect(() => JSON.parse(Buffer.from(handle.split(".")[3]!, "base64url").toString("utf8")))
        .toThrow();
    }
  });

  it("caps expiry at 15 minutes and the session/instance ceiling", () => {
    const [fifteen] = mintCandidateHandles(base);
    expect(Number(fifteen!.split(".")[2]) - Number(fifteen!.split(".")[1])).toBe(900);
    const [short] = mintCandidateHandles({ ...base, ceilingMs: NOW_MS + 91_999 });
    expect(Number(short!.split(".")[2]) - Number(short!.split(".")[1])).toBe(91);
  });

  it("recovers exactly one current Top-3 server identity", () => {
    const handles = mintCandidateHandles(base);
    expect(resolveCandidateHandle({ ...base, handle: handles[1]! })).toBe("internal-seeded-B");
  });

  it.each([
    "CGCH1.1.2." + "A".repeat(43),
    "cgch1.01.2." + "A".repeat(43),
    "cgch1.1.02." + "A".repeat(43),
    "cgch1.1.2." + "A".repeat(42),
    "cgch1.1.2." + "A".repeat(44),
    "cgch1.1.2." + "=".repeat(43),
  ])("rejects malformed/noncanonical syntax: %s", (handle) => {
    expect(() => resolveCandidateHandle({ ...base, handle }))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("invalidates tamper, expiry, cross-context and every current snapshot change", () => {
    const [handle] = mintCandidateHandles(base);
    const parts = handle!.split(".");
    const tamperedMac = `${parts[3]![0] === "A" ? "B" : "A"}${parts[3]!.slice(1)}`;
    const changed = [
      { handle: `${parts.slice(0, 3).join(".")}.${tamperedMac}` },
      { demoInstanceId: "other-instance" },
      { reportId: "other-report" },
      { reportVersion: 3 },
      { catalogVersion: 5 },
      { inventoryItemIds: ["internal-seeded-X", ...base.inventoryItemIds.slice(1)] },
    ];
    for (const patch of changed) {
      expect(() => resolveCandidateHandle({ ...base, handle: handle!, ...patch }))
        .toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
    }
    expect(() => resolveCandidateHandle({ ...base, handle: handle!, nowMs: NOW_MS + 900_000 }))
      .toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
  });

  it("rejects future, reverse, overlong and beyond-ceiling lifetimes", () => {
    const [valid] = mintCandidateHandles(base);
    const [, iat, exp, mac] = valid!.split(".");
    for (const handle of [
      `cgch1.${Number(iat) + 1}.${exp}.${mac}`,
      `cgch1.${iat}.${iat}.${mac}`,
      `cgch1.${iat}.${Number(iat) + 901}.${mac}`,
    ]) {
      expect(() => resolveCandidateHandle({ ...base, handle }))
        .toThrow(expect.any(DomainError));
    }
    expect(() => resolveCandidateHandle({ ...base, handle: valid!, ceilingMs: NOW_MS + 899_000 }))
      .toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
  });
});
