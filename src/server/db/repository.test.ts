import { Buffer } from "node:buffer";
import { closeSync, openSync, rmSync } from "node:fs";
import { findMatches } from "@/features/matching/match-service";
import { report as matchingReport } from "@/test/factories";
import { createKeyring } from "@/server/security/keyring";
import { DomainError } from "@/shared/domain-error";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabaseConnection } from "./connection";
import { initializeDatabase, readSqliteVersion } from "./migrate";
import { createTestDatabase, TEST_MASTER_KEY, type TestDatabase } from "./test-harness";

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

function setup(now = Date.UTC(2026, 7, 26, 12)): TestDatabase {
  testDatabase = createTestDatabase(now);
  return testDatabase;
}

function createReportInput(instanceId: string) {
  return {
    demoInstanceId: instanceId,
    ownerActorId: "claimant-demo",
    category: "earbuds",
    timeWindow: {
      from: "2026-08-25T17:00:00.000Z",
      to: "2026-08-25T19:00:00.000Z",
    },
    area: "library",
    color: "black",
    publicTags: ["wireless", "charging-case"],
    publicDescription: "Black wireless earbud charging case.",
  };
}

describe("SQLite 连接与配置密钥连续性", () => {
  it("为每个连接启用外键、WAL、FULL 同步与统一 busy timeout", () => {
    const test = setup();

    expect(test.database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(test.database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(test.database.pragma("synchronous", { simple: true })).toBe(2);
    expect(test.database.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(readSqliteVersion(test.database)).toMatch(/^\d+\.\d+\.\d+$/);

    const second = openDatabaseConnection(test.databasePath);
    expect(second.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(second.pragma("journal_mode", { simple: true })).toBe("wal");
    second.close();
  });

  it("同一密钥可重开，错误密钥或不匹配 metadata 均安全失败", () => {
    const test = setup();
    const databasePath = test.databasePath;
    test.database.close();

    const reopened = initializeDatabase({
      databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    });
    reopened.close();

    expect(() => initializeDatabase({
      databasePath,
      keyring: createKeyring(Buffer.alloc(32, 8).toString("base64")),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));

    const tamper = openDatabaseConnection(databasePath);
    tamper.prepare("UPDATE database_metadata SET key_check_authenticator = zeroblob(32)").run();
    tamper.close();
    expect(() => initializeDatabase({
      databasePath,
      keyring: createKeyring(TEST_MASTER_KEY),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });

  it("拒绝已有空数据库，不把它误判成可初始化的新库", () => {
    const test = setup();
    const emptyPath = `${test.databasePath}.existing-empty`;
    closeSync(openSync(emptyPath, "w"));

    expect(() => initializeDatabase({
      databasePath: emptyPath,
      keyring: createKeyring(TEST_MASTER_KEY),
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    rmSync(emptyPath, { force: true });
  });
});

describe("隔离演示实例与种子", () => {
  it("在单事务中物理克隆 1 个强匹配与 6 个同类干扰项", () => {
    const now = Date.UTC(2026, 7, 26, 12);
    const { repository } = setup(now);
    const first = repository.createDemoInstance();
    const second = repository.createDemoInstance();

    expect(first).toMatchObject({ catalogVersion: 1, expiresAtMs: now + TWO_HOURS_MS });
    expect(second.demoInstanceId).not.toBe(first.demoInstanceId);
    const firstItems = repository.listServerInternalFoundItems(first.demoInstanceId);
    const secondItems = repository.listServerInternalFoundItems(second.demoInstanceId);
    expect(firstItems).toHaveLength(7);
    expect(firstItems.every((item) => item.category === "earbuds")).toBe(true);
    expect(new Set(firstItems.map((item) => item.inventoryItemId)).size).toBe(7);
    expect(secondItems.map((item) => item.inventoryItemId)).not.toEqual(
      firstItems.map((item) => item.inventoryItemId),
    );

    const matches = findMatches(
      matchingReport({ ...createReportInput(first.demoInstanceId), timeWindow: createReportInput(first.demoInstanceId).timeWindow }),
      firstItems.map(({ inventoryItemId, ...item }) => ({ ...item, candidateId: inventoryItemId })),
    );
    expect(matches[0]?.confidence).toBe("strong");
  });

  it("到期边界立即拒绝读写，清理只删除已到期实例", () => {
    const now = Date.UTC(2026, 7, 26, 12);
    const test = setup(now);
    const expired = test.repository.createDemoInstance();
    test.setNow(now + 1);
    const live = test.repository.createDemoInstance();
    test.setNow(expired.expiresAtMs);

    expect(() => test.repository.getDemoInstance(expired.demoInstanceId)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(() => test.repository.createLostReport(createReportInput(expired.demoInstanceId))).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(test.repository.deleteExpiredDemoInstances(expired.expiresAtMs)).toBe(1);
    expect(test.repository.getDemoInstance(live.demoInstanceId).demoInstanceId).toBe(live.demoInstanceId);
  });
});

describe("事务、范围、版本与幂等契约", () => {
  it("资源版本和 catalogVersion 成功时各增一次，陈旧写入不留下审计", () => {
    const { repository } = setup();
    const instance = repository.createDemoInstance();
    const report = repository.createLostReport(createReportInput(instance.demoInstanceId));
    const updatedReport = repository.updateLostReport({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      expectedVersion: 1,
      patch: { status: "PUBLISHED" },
      actorId: "claimant-demo",
    });
    expect(updatedReport.version).toBe(2);
    const beforeStaleAudit = repository.listAuditEvents(instance.demoInstanceId).length;
    expect(() => repository.updateLostReport({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      expectedVersion: 1,
      patch: { status: "ARCHIVED" },
      actorId: "claimant-demo",
    })).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
    expect(repository.listAuditEvents(instance.demoInstanceId)).toHaveLength(beforeStaleAudit);

    const item = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!;
    const changedItem = repository.updateFoundItem({
      demoInstanceId: instance.demoInstanceId,
      inventoryItemId: item.inventoryItemId,
      expectedVersion: 1,
      patch: { status: "HELD" },
      actorId: "staff-demo",
    });
    expect(changedItem).toMatchObject({ version: 2, catalogVersion: 2 });
    expect(() => repository.updateFoundItem({
      demoInstanceId: instance.demoInstanceId,
      inventoryItemId: item.inventoryItemId,
      expectedVersion: 1,
      patch: { color: "navy" },
      actorId: "staff-demo",
    })).toThrow(expect.objectContaining({ code: "STATE_CHANGED" }));
    expect(repository.getDemoInstance(instance.demoInstanceId).catalogVersion).toBe(2);

    const claim = repository.createClaim({
      demoInstanceId: instance.demoInstanceId,
      reportId: report.reportId,
      inventoryItemId: item.inventoryItemId,
      claimantActorId: "claimant-demo",
    });
    expect(repository.updateClaim({
      demoInstanceId: instance.demoInstanceId,
      claimId: claim.claimId,
      expectedVersion: 1,
      patch: { status: "UNDER_REVIEW" },
      actorId: "claimant-demo",
    }).version).toBe(2);
  });

  it("跨实例方法与数据库复合外键都拒绝有效但不属于本实例的 ID", () => {
    const { repository, database } = setup();
    const first = repository.createDemoInstance();
    const second = repository.createDemoInstance();
    const report = repository.createLostReport(createReportInput(first.demoInstanceId));
    const item = repository.listServerInternalFoundItems(first.demoInstanceId)[0]!;

    expect(() => repository.getLostReport(second.demoInstanceId, report.reportId)).toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }),
    );
    expect(() => repository.createClaim({
      demoInstanceId: second.demoInstanceId,
      reportId: report.reportId,
      inventoryItemId: item.inventoryItemId,
      claimantActorId: "claimant-demo",
    })).toThrow(DomainError);
    expect(() => database.prepare(`
      INSERT INTO claims (
        demo_instance_id, id, report_id, found_item_id, claimant_actor_id,
        status, attempts, evidence_eligible, pass_generation, version
      ) VALUES (?, ?, ?, ?, ?, 'EVIDENCE_REQUIRED', 0, 0, 0, 1)
    `).run(second.demoInstanceId, "cross-instance", report.reportId, item.inventoryItemId, "claimant-demo"))
      .toThrow(expect.objectContaining({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" }));
  });

  it("异常或 async 回调整体回滚；幂等重试不重放 mutation/audit", () => {
    const { repository } = setup();
    const instance = repository.createDemoInstance();

    expect(() => repository.withTransaction((transactionRepository) => {
      transactionRepository.createLostReport(createReportInput(instance.demoInstanceId));
      throw new Error("rollback-probe");
    })).toThrow("rollback-probe");
    expect(repository.listLostReports(instance.demoInstanceId)).toEqual([]);
    let asyncCallbackInvoked = false;
    expect(() => repository.withTransaction(async () => {
      asyncCallbackInvoked = true;
      return "not-supported";
    }))
      .toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
    expect(asyncCallbackInvoked).toBe(false);

    let mutations = 0;
    const request = {
      demoInstanceId: instance.demoInstanceId,
      actorId: "claimant-demo",
      action: "CREATE_REPORT",
      idempotencyKey: "opaque-retry-key",
      requestFingerprint: "sha256:bounded-public-request-v1",
    } as const;
    const first = repository.runIdempotent(request, () => {
      mutations += 1;
      const created = repository.createLostReport(createReportInput(instance.demoInstanceId));
      return { reportId: created.reportId, status: created.status, version: created.version };
    });
    const auditCount = repository.listAuditEvents(instance.demoInstanceId).length;
    expect(repository.runIdempotent(request, () => {
      mutations += 1;
      return { replayed: true };
    })).toEqual(first);
    expect(mutations).toBe(1);
    expect(repository.listAuditEvents(instance.demoInstanceId)).toHaveLength(auditCount);
    expect(() => repository.runIdempotent(
      { ...request, requestFingerprint: "sha256:different-public-request" },
      () => ({ replayed: true }),
    )).toThrow(expect.objectContaining({ code: "CONFLICT" }));
  });
});
