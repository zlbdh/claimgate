import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { DomainError } from "@/shared/domain-error";
import { tamperCandidateHandleMac } from "@/test/candidate-handle-tamper";
import {
  mintCandidateHandles,
  preflightCandidateHandle,
  resolveCandidateHandle,
} from "./candidate-handle";

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
    const preflight = preflightCandidateHandle({ handle: handles[1]!, nowMs: NOW_MS });
    expect(resolveCandidateHandle({ ...base, preflight })).toBe("internal-seeded-B");
  });

  it("pure-preflights syntax/time without any snapshot inputs", () => {
    const [handle] = mintCandidateHandles(base);
    expect(preflightCandidateHandle({ handle: handle!, nowMs: NOW_MS })).toMatchObject({
      issuedAtSeconds: Math.floor(NOW_MS / 1_000),
      expiresAtSeconds: Math.floor(NOW_MS / 1_000) + 900,
    });
    expect(() => preflightCandidateHandle({ handle: "bad", nowMs: NOW_MS }))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it.each([
    "CGCH1.1.2." + "A".repeat(43),
    "cgch1.01.2." + "A".repeat(43),
    "cgch1.1.02." + "A".repeat(43),
    "cgch1.1.2." + "A".repeat(42),
    "cgch1.1.2." + "A".repeat(44),
    "cgch1.1.2." + "=".repeat(43),
  ])("rejects malformed/noncanonical syntax: %s", (handle) => {
    expect(() => preflightCandidateHandle({ handle, nowMs: NOW_MS }))
      .toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });

  it("invalidates tamper, expiry, cross-context and every current snapshot change", () => {
    const [handle] = mintCandidateHandles(base);
    const changed = [
      { handle: tamperCandidateHandleMac(handle!) },
      { demoInstanceId: "other-instance" },
      { reportId: "other-report" },
      { reportVersion: 3 },
      { catalogVersion: 5 },
      { inventoryItemIds: ["internal-seeded-X", ...base.inventoryItemIds.slice(1)] },
    ];
    for (const patch of changed) {
      const candidate = patch.handle ?? handle!;
      const preflight = preflightCandidateHandle({ handle: candidate, nowMs: NOW_MS });
      expect(() => resolveCandidateHandle({ ...base, preflight, ...patch }))
        .toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
    }
    expect(() => preflightCandidateHandle({ handle: handle!, nowMs: NOW_MS + 900_000 }))
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
      expect(() => preflightCandidateHandle({ handle, nowMs: NOW_MS }))
        .toThrow(expect.any(DomainError));
    }
    const preflight = preflightCandidateHandle({ handle: valid!, nowMs: NOW_MS });
    expect(() => resolveCandidateHandle({ ...base, preflight, ceilingMs: NOW_MS + 899_000 }))
      .toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
  });

  it("keeps canonical byte-flip tampering structurally valid across 64 MACs", () => {
    for (let index = 0; index < 64; index += 1) {
      const [handle] = mintCandidateHandles({
        ...base,
        inventoryItemIds: [`internal-seeded-${index}`],
      });
      const changed = tamperCandidateHandleMac(handle!);
      expect(() => preflightCandidateHandle({ handle: changed, nowMs: NOW_MS })).not.toThrow();
    }
  });
});
