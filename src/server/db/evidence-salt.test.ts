import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceDigester } from "@/features/evidence/evidence-digester";
import { createKeyring } from "@/server/security/keyring";
import { openDatabaseConnection } from "./connection";
import { createRepository } from "./repository";
import { createTestDatabase, TEST_MASTER_KEY, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function evidenceDigester() {
  return createEvidenceDigester(createKeyring(TEST_MASTER_KEY).getKey("evidence"));
}

function deterministicRandomBytes() {
  let sequence = 0;
  return (size: number): Buffer => {
    const value = Buffer.alloc(size);
    value.writeUInt32BE(++sequence, size - 4);
    return value;
  };
}

const badDependencyCases = [
  {
    name: "constant random source",
    options: () => ({
      evidenceDigester: evidenceDigester(),
      randomBytes: () => Buffer.alloc(16, 5),
    }),
  },
  {
    name: "shared mutable random Buffer",
    options: () => {
      const shared = Buffer.alloc(16);
      let sequence = 0;
      return {
        evidenceDigester: evidenceDigester(),
        randomBytes: () => {
          shared.writeUInt32BE(++sequence, 12);
          return shared;
        },
      };
    },
  },
  {
    name: "short random output",
    options: () => ({ evidenceDigester: evidenceDigester(), randomBytes: () => Buffer.alloc(15) }),
  },
  {
    name: "long random output",
    options: () => ({ evidenceDigester: evidenceDigester(), randomBytes: () => Buffer.alloc(17) }),
  },
  {
    name: "throwing random source",
    options: () => ({
      evidenceDigester: evidenceDigester(),
      randomBytes: () => { throw new Error("raw random failure"); },
    }),
  },
  {
    name: "short digester output",
    options: () => ({
      evidenceDigester: Object.freeze({ digest: () => Buffer.alloc(31) }),
      randomBytes: deterministicRandomBytes(),
    }),
  },
  {
    name: "long digester output",
    options: () => ({
      evidenceDigester: Object.freeze({ digest: () => Buffer.alloc(33) }),
      randomBytes: deterministicRandomBytes(),
    }),
  },
  {
    name: "throwing digester",
    options: () => ({
      evidenceDigester: Object.freeze({ digest: () => { throw new Error("raw digest failure"); } }),
      randomBytes: deterministicRandomBytes(),
    }),
  },
];

describe("evidence salt source boundary", () => {
  it.each(badDependencyCases)("$name 有界失败并回滚所有实例行", ({ options }) => {
    testDatabase = createTestDatabase();
    const { database } = testDatabase;
    const repository = createRepository({ database, ...options() });
    expect(() => repository.createDemoInstance()).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    for (const table of ["demo_instances", "found_items", "item_evidence_slots", "audit_events"]) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
  });

  it("跨实例复用历史 salt 时第二个实例整笔回滚", () => {
    testDatabase = createTestDatabase();
    const { database } = testDatabase;
    let calls = 0;
    const repository = createRepository({
      database,
      evidenceDigester: evidenceDigester(),
      randomBytes: (size) => {
        calls += 1;
        const value = Buffer.alloc(size);
        value.writeUInt32BE(calls <= 21 ? calls : calls === 22 ? 1 : calls, size - 4);
        return value;
      },
    });
    repository.createDemoInstance();
    expect(() => repository.createDemoInstance()).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    expect(database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM found_items").get()).toEqual({ count: 7 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM item_evidence_slots").get()).toEqual({ count: 21 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM audit_events").get()).toEqual({ count: 1 });
  });

  it("第二连接复用已提交 salt 时有界失败且不留部分行", () => {
    testDatabase = createTestDatabase();
    const first = testDatabase.repository.createDemoInstance();
    const firstSalt = (testDatabase.database.prepare(`
      SELECT salt FROM item_evidence_slots WHERE demo_instance_id = ? LIMIT 1
    `).get(first.demoInstanceId) as { salt: Buffer }).salt;
    const secondDatabase = openDatabaseConnection(testDatabase.databasePath);
    try {
      const second = createRepository({
        database: secondDatabase,
        evidenceDigester: evidenceDigester(),
        randomBytes: () => Buffer.from(firstSalt),
      });
      expect(() => second.createDemoInstance()).toThrow(
        expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
      );
    } finally {
      secondDatabase.close();
    }
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 1 });
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM found_items").get())
      .toEqual({ count: 7 });
    expect(testDatabase.database.prepare("SELECT COUNT(*) AS count FROM item_evidence_slots").get())
      .toEqual({ count: 21 });
  });
});
