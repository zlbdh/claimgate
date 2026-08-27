import { Buffer } from "node:buffer";
import { createHmac } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEvidenceDigester,
  EVIDENCE_SLOTS,
  type EvidenceDigester,
  type EvidenceDigestInput,
} from "@/features/evidence/evidence-digester";
import { verifyEvidence } from "@/features/evidence/evidence-service";
import { normalizeEvidence } from "@/features/evidence/normalize-evidence";
import { createKeyring } from "@/server/security/keyring";
import { initializeDatabase } from "./migrate";
import { createRepository } from "./repository";
import { createTestDatabase, TEST_MASTER_KEY, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  vi.restoreAllMocks();
  testDatabase?.close();
  testDatabase = undefined;
});

function evidenceDigester(masterKey = TEST_MASTER_KEY) {
  return createEvidenceDigester(createKeyring(masterKey).getKey("evidence"));
}

function deterministicRandomBytes() {
  let sequence = 0;
  return (size: number): Buffer => {
    const value = Buffer.alloc(size);
    value.writeUInt32BE(++sequence, size - 4);
    return value;
  };
}

function intendedItemId(test: TestDatabase, instanceId: string): string {
  return (test.database.prepare(`
    SELECT id FROM found_items WHERE demo_instance_id = ? ORDER BY rowid LIMIT 1
  `).get(instanceId) as { id: string }).id;
}

function nonSeedSourceFiles(): Buffer[] {
  const privateSeed = resolve("src/server/db/private-evidence-seed.ts").toLowerCase();
  return ["src", "scripts", "tests", "docs"].flatMap((root) =>
    readdirSync(resolve(root), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => resolve(entry.parentPath, entry.name))
      .filter((path) => path.toLowerCase() !== privateSeed)
      .map((path) => readFileSync(path))
  );
}

function recordingEvidenceDigester(): {
  digester: EvidenceDigester;
  calls: EvidenceDigestInput[];
} {
  const delegate = evidenceDigester();
  const calls: EvidenceDigestInput[] = [];
  return {
    calls,
    digester: Object.freeze({
      digest(input) {
        calls.push({ ...input, salt: Buffer.from(input.salt) });
        return delegate.digest(input);
      },
    }),
  };
}

function recordedAnswers(calls: EvidenceDigestInput[], itemId: string) {
  return Object.fromEntries(calls
    .filter((call) => call.itemId === itemId)
    .map((call) => [call.slot, call.value]));
}

function containsCanary(value: unknown, canaries: readonly string[]): boolean {
  const seen = new Set<object>();
  const inspect = (entry: unknown): boolean => {
    if (typeof entry === "string") return canaries.some((canary) => entry.includes(canary));
    if (Buffer.isBuffer(entry)) {
      return canaries.some((canary) => entry.includes(Buffer.from(canary, "utf8")));
    }
    if (!entry || typeof entry !== "object" || seen.has(entry)) return false;
    seen.add(entry);
    return Reflect.ownKeys(entry).some((key) => inspect(key) || inspect(Reflect.get(entry, key)));
  };
  return inspect(value);
}

describe("server-internal evidence repository", () => {
  it("private seed 依赖 server-only 且生产只导出 seeding operation", () => {
    const source = readFileSync(resolve("src/server/db/private-evidence-seed.ts"), "utf8");
    expect(source).toMatch(/^import "server-only";/m);
    expect(source).not.toMatch(/export function (verifyFictionalSeedForTest|privateEvidenceSeedsAreDistinctForTest|privateEvidenceAppearsInForTest)/);
    expect([...source.matchAll(/export function ([A-Za-z0-9_]+)/g)].map((match) => match[1]))
      .toEqual(["seedPrivateEvidenceForItem"]);
  });

  it("缺失/未冻结 digester 或随机源在创建实例前失败，坏输出整笔回滚", () => {
    testDatabase = createTestDatabase();
    const { database } = testDatabase;
    expect(() => createRepository({ database } as never)).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    expect(() => createRepository({
      database,
      evidenceDigester: { digest: () => Buffer.alloc(32) } as never,
      randomBytes: deterministicRandomBytes(),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    expect(() => createRepository({
      database,
      evidenceDigester: evidenceDigester(),
      randomBytes: undefined as never,
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));

    const before = database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get();
    for (const repository of [
      createRepository({
        database,
        evidenceDigester: evidenceDigester(),
        randomBytes: () => Buffer.alloc(15),
      }),
      createRepository({
        database,
        evidenceDigester: Object.freeze({ digest: () => Buffer.alloc(31) }),
        randomBytes: deterministicRandomBytes(),
      }),
    ]) {
      expect(() => repository.createDemoInstance()).toThrow(
        expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
      );
      expect(database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get()).toEqual(before);
    }
  });

  it("active scoped item 恰好返回三个 validated clone，跨实例/缺失/损坏失败关闭", () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const first = repository.createDemoInstance();
    const second = repository.createDemoInstance();
    const itemId = intendedItemId(testDatabase, first.demoInstanceId);
    expect(repository.listServerInternalEvidenceSlots(first.demoInstanceId, itemId)
      .map(({ slot }) => slot)).toEqual(EVIDENCE_SLOTS);
    expect(() => repository.listServerInternalEvidenceSlots(second.demoInstanceId, itemId))
      .toThrow(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(() => repository.listServerInternalEvidenceSlots(first.demoInstanceId, "missing"))
      .toThrow(expect.objectContaining({ code: "NOT_FOUND" }));

    database.pragma("ignore_check_constraints = ON");
    database.prepare(`
      UPDATE item_evidence_slots SET digest = zeroblob(31)
      WHERE demo_instance_id = ? AND found_item_id = ? AND slot = 'unique_mark'
    `).run(first.demoInstanceId, itemId);
    expect(() => repository.listServerInternalEvidenceSlots(first.demoInstanceId, itemId))
      .toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });

  it("同一主密钥重启后验证强候选；换钥在 repository/service 前失败", () => {
    const recording = recordingEvidenceDigester();
    testDatabase = createTestDatabase(Date.UTC(2026, 7, 26, 12), {
      evidenceDigester: recording.digester,
    });
    const instance = testDatabase.repository.createDemoInstance();
    const itemId = intendedItemId(testDatabase, instance.demoInstanceId);
    const initialSlots = testDatabase.repository.listServerInternalEvidenceSlots(
      instance.demoInstanceId,
      itemId,
    );
    const answers = recordedAnswers(recording.calls, itemId);
    expect(verifyEvidence({
      digester: evidenceDigester(),
      demoInstanceId: instance.demoInstanceId,
      itemId,
      storedSlots: initialSlots,
      answers,
      priorFailedAttempts: 0,
    })).toEqual({ outcome: "ELIGIBLE_FOR_REVIEW" });
    testDatabase.database.close();

    const reopened = initializeDatabase({
      databasePath: testDatabase.databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    });
    const repository = createRepository({
      database: reopened,
      evidenceDigester: evidenceDigester(),
      randomBytes: deterministicRandomBytes(),
      now: () => Date.UTC(2026, 7, 26, 12),
    });
    expect(verifyEvidence({
      digester: evidenceDigester(),
      demoInstanceId: instance.demoInstanceId,
      itemId,
      storedSlots: repository.listServerInternalEvidenceSlots(instance.demoInstanceId, itemId),
      answers,
      priorFailedAttempts: 0,
    })).toEqual({ outcome: "ELIGIBLE_FOR_REVIEW" });
    reopened.close();
    expect(() => initializeDatabase({
      databasePath: testDatabase!.databasePath,
      keyring: createKeyring(Buffer.alloc(32, 88).toString("base64")),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });

  it("录制的私有答案彼此不同，不跨 DB/DTO/audit/log/serialization/source 边界且无裸摘要", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const recording = recordingEvidenceDigester();
    testDatabase = createTestDatabase(Date.UTC(2026, 7, 26, 12), {
      evidenceDigester: recording.digester,
    });
    const instance = testDatabase.repository.createDemoInstance();
    const databaseValues = testDatabase.database.prepare(`
      SELECT demo_instance_id, found_item_id, slot, salt, digest FROM item_evidence_slots
    `).all();
    let boundedError: unknown;
    const failing = createRepository({
      database: testDatabase.database,
      evidenceDigester: Object.freeze({
        digest(input) { throw new Error(input.value); },
      }),
      randomBytes: () => Buffer.alloc(16, 200),
    });
    try {
      failing.createDemoInstance();
    } catch (caught) {
      boundedError = caught;
    }
    expect(boundedError).toEqual(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    const publicValues = [
      testDatabase.repository.listPublicInventory(instance.demoInstanceId),
      testDatabase.repository.listAuditEvents(instance.demoInstanceId),
      databaseValues,
      JSON.stringify(databaseValues),
      log.mock.calls,
      error.mock.calls,
      nonSeedSourceFiles(),
      boundedError,
      JSON.stringify(boundedError),
    ];
    const rawCanaries = recording.calls.map(({ value }) => value);
    const normalizedCanaries = rawCanaries.map(normalizeEvidence);
    expect(recording.calls).toHaveLength(21);
    expect(new Set(rawCanaries).size).toBe(21);
    expect(new Set(normalizedCanaries).size).toBe(21);
    expect(publicValues.map((value) => containsCanary(value, [...rawCanaries, ...normalizedCanaries])))
      .toEqual([false, false, false, false, false, false, false, false, false]);

    const storedDigests = (databaseValues as Array<{ digest: Buffer }>).map(({ digest }) => digest);
    const key = createKeyring(TEST_MASTER_KEY).getKey("evidence");
    const reusableDigester = evidenceDigester();
    const forbiddenDigests = recording.calls.flatMap((call) => [
      createHmac("sha256", key).update(normalizeEvidence(call.value)).digest(),
      reusableDigester.digest({ ...call, salt: Buffer.alloc(16) }),
    ]);
    expect(forbiddenDigests.some((candidate) =>
      storedDigests.some((stored) => stored.equals(candidate))
    )).toBe(false);
  });
});
