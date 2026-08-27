import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import { EVIDENCE_SLOTS } from "@/features/evidence/evidence-digester";
import {
  ADVERSARIAL_BUFFER_KINDS,
  adversarialBuffer,
} from "@/test/adversarial-buffer";
import { listServerInternalEvidenceSlots } from "./evidence-repository";
import type { RepositoryContext } from "./repository-types";

function contextWithRows(rows: unknown[]): RepositoryContext {
  const database = {
    prepare(source: string) {
      if (source.includes("FROM demo_instances")) {
        return {
          get: () => ({
            demoInstanceId: "instance-a",
            createdAtMs: 1,
            expiresAtMs: 10_000,
            catalogVersion: 1,
          }),
        };
      }
      if (source.trim() === "SELECT id FROM found_items") {
        return { all: () => [{ id: "item-a" }] };
      }
      if (source.includes("SELECT 1 FROM found_items")) return { get: () => ({ found: 1 }) };
      if (source.includes("SELECT slot, salt, digest")) return { all: () => rows };
      throw new Error("unexpected test query");
    },
  };
  return {
    database,
    now: () => 100,
    randomId: () => "unused",
    evidenceDigester: Object.freeze({ digest: () => Buffer.alloc(32) }),
    randomBytes: Buffer.alloc,
  } as unknown as RepositoryContext;
}

describe("SQLite evidence Buffer boundary", () => {
  it.each(ADVERSARIAL_BUFFER_KINDS)("DB salt 拒绝 %s Buffer 且零陷阱", (kind) => {
    const counter = { count: 0 };
    const rows = EVIDENCE_SLOTS.map((slot, index) => ({
      slot,
      salt: index === 0
        ? adversarialBuffer(kind, 16, counter)
        : Buffer.alloc(16, index + 1),
      digest: Buffer.alloc(32, index + 11),
    }));
    expect(() => listServerInternalEvidenceSlots(
      contextWithRows(rows),
      "instance-a",
      "item-a",
    )).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    expect(counter.count).toBe(0);
  });
});
