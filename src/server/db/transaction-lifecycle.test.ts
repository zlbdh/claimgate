import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("事务仓库生命周期", () => {
  it("普通函数返回 Promise 后排队的工作不能逃逸回滚边界", async () => {
    testDatabase = createTestDatabase();
    const { repository } = testDatabase;
    const instance = repository.createDemoInstance();
    const beforeAudit = repository.listAuditEvents(instance.demoInstanceId).length;
    let scopedRepository: typeof repository | undefined;

    expect(() => repository.withTransaction((transactionRepository) => {
      scopedRepository = transactionRepository;
      return Promise.resolve().then(() => transactionRepository.createLostReport({
        demoInstanceId: instance.demoInstanceId,
        ownerActorId: "claimant-demo",
        category: "earbuds",
        timeWindow: { from: "2026-08-25T17:00:00.000Z", to: "2026-08-25T19:00:00.000Z" },
        area: "library",
        color: "black",
        publicTags: ["wireless"],
        publicDescription: "Black earbud case.",
      })) as never;
    })).toThrow(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));

    await Promise.resolve();
    expect(repository.listLostReports(instance.demoInstanceId)).toEqual([]);
    expect(repository.listAuditEvents(instance.demoInstanceId)).toHaveLength(beforeAudit);
    expect(() => scopedRepository!.listLostReports(instance.demoInstanceId)).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
  });

  it("同步回调结束后排队的 microtask 也不能继续使用 scoped repository", async () => {
    testDatabase = createTestDatabase();
    const { repository } = testDatabase;
    const instance = repository.createDemoInstance();
    let escapedError: unknown;

    repository.withTransaction((transactionRepository) => {
      queueMicrotask(() => {
        try {
          transactionRepository.listLostReports(instance.demoInstanceId);
        } catch (error) {
          escapedError = error;
        }
      });
      return "committed";
    });
    await Promise.resolve();
    expect(escapedError).toEqual(expect.objectContaining({ code: "CONFIGURATION_ERROR" }));
  });
});
