import { randomBytes, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createEvidenceDigester } from "@/features/evidence/evidence-digester";
import { createKeyring } from "@/server/security/keyring";
import { createRepository } from "./repository";
import { createTestDatabase, TEST_MASTER_KEY, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function insertManualInstance(test: TestDatabase, id: string): void {
  test.database.prepare(`
    INSERT INTO demo_instances (id, created_at_ms, expires_at_ms, catalog_version)
    VALUES (?, 1, 9999999999999, 1)
  `).run(id);
}

function insertManualItem(test: TestDatabase, demoInstanceId: string, id: string): void {
  test.database.prepare(`
    INSERT INTO found_items (
      demo_instance_id, id, category, found_at, area, color,
      public_tags_json, public_description, status, version
    ) VALUES (?, ?, 'earbuds', '2026-08-25', 'library', 'black',
      '["wireless"]', 'safe', 'AVAILABLE', 1)
  `).run(demoInstanceId, id);
}

describe("Global separation of DemoInstance and internal inventory IDs", () => {
  it("when an item exists first, rejects demo-instance INSERT/UPDATE to the same ID", () => {
    testDatabase = createTestDatabase();
    const normal = testDatabase.repository.createDemoInstance();
    insertManualItem(testDatabase, normal.demoInstanceId, "future-instance-id");
    insertManualInstance(testDatabase, "updatable-instance-id");

    expect(() => insertManualInstance(testDatabase!, "future-instance-id")).toThrow();
    expect(() => testDatabase!.database.prepare(`
      UPDATE demo_instances SET id = 'future-instance-id' WHERE id = 'updatable-instance-id'
    `).run()).toThrow();
  });

  it("when an instance exists first, rejects found-item INSERT/UPDATE to the same ID", () => {
    testDatabase = createTestDatabase();
    const normal = testDatabase.repository.createDemoInstance();
    insertManualInstance(testDatabase, "reserved-public-instance-id");
    insertManualItem(testDatabase, normal.demoInstanceId, "updatable-item-id");

    expect(() => insertManualItem(
      testDatabase!, normal.demoInstanceId, "reserved-public-instance-id",
    )).toThrow();
    expect(() => testDatabase!.database.prepare(`
      UPDATE found_items SET id = 'reserved-public-instance-id'
      WHERE demo_instance_id = ? AND id = 'updatable-item-id'
    `).run(normal.demoInstanceId)).toThrow();
  });

  it("an injected instance ID colliding with an existing internal ID rolls back creation", () => {
    testDatabase = createTestDatabase();
    const { database, repository } = testDatabase;
    const first = repository.createDemoInstance();
    const internalId = repository.listServerInternalFoundItems(first.demoInstanceId)[0]!.inventoryItemId;
    const before = {
      instances: database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get(),
      items: database.prepare("SELECT COUNT(*) AS count FROM found_items").get(),
      audits: database.prepare("SELECT COUNT(*) AS count FROM audit_events").get(),
    };
    let sequence = 0;
    const colliding = createRepository({
      database,
      now: () => Date.UTC(2026, 7, 26, 12),
      randomId: () => sequence++ === 0 ? internalId : `seed-${sequence}-${randomUUID()}`,
      evidenceDigester: createEvidenceDigester(createKeyring(TEST_MASTER_KEY).getKey("evidence")),
      randomBytes,
    });

    expect(() => colliding.createDemoInstance()).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
    expect({
      instances: database.prepare("SELECT COUNT(*) AS count FROM demo_instances").get(),
      items: database.prepare("SELECT COUNT(*) AS count FROM found_items").get(),
      audits: database.prepare("SELECT COUNT(*) AS count FROM audit_events").get(),
    }).toEqual(before);
  });

  it("reading a public DemoInstance with a legacy collision fails closed; normal instances remain usable", () => {
    testDatabase = createTestDatabase();
    const { database, repository } = testDatabase;
    const normal = repository.createDemoInstance();
    expect(repository.getDemoInstance(normal.demoInstanceId)).toEqual(normal);

    database.exec("DROP TRIGGER found_items_id_not_demo_instance_id_global_insert");
    insertManualInstance(testDatabase, "legacy-public-instance-id");
    insertManualItem(testDatabase, normal.demoInstanceId, "legacy-public-instance-id");

    expect(() => repository.getDemoInstance("legacy-public-instance-id")).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
  });
});
