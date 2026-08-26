import { afterEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("幂等 acknowledgement 的 prototype-safe canonical serialization", () => {
  it("忽略继承的 Object.prototype.toJSON，且首调/replay 是可传输普通 DTO", async () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const instance = repository.createDemoInstance();
    const internalId = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!.inventoryItemId;
    const toJsonDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    const pollutedDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, "pollutedAckValue");
    try {
      Object.defineProperty(Object.prototype, "pollutedAckValue", {
        configurable: true,
        enumerable: false,
        value: internalId,
      });
      Object.defineProperty(Object.prototype, "toJSON", {
        configurable: true,
        enumerable: false,
        value(this: Record<string, unknown>) {
          if (this.kind !== "report_ack") return this;
          return Object.assign(Object.create(null) as object, {
            kind: "report_ack",
            reportId: internalId,
            status: "DRAFT",
            version: 1,
          });
        },
      });
      const request = {
        demoInstanceId: instance.demoInstanceId,
        actorId: "claimant-demo",
        action: "draft_create",
        idempotencyKey: "prototype-safe",
        requestFingerprint: "prototype-safe",
      } as const;
      const expected = {
        kind: "report_ack" as const,
        reportId: "safe-report",
        status: "DRAFT" as const,
        version: 1,
      };
      const first = repository.runIdempotent(request, () => expected);
      const replay = repository.runIdempotent(request, () => {
        throw new Error("must not replay");
      });
      expect(first).toEqual(expected);
      expect(replay).toEqual(expected);
      expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
      expect(Object.keys(first)).toEqual(["kind", "reportId", "status", "version"]);
      expect(Object.getOwnPropertyDescriptor(first, "toJSON")).toEqual({
        configurable: false,
        enumerable: false,
        value: undefined,
        writable: false,
      });
      expect({ ...first }).toEqual(expected);
      expect(structuredClone(first)).toEqual(expected);
      expect(await Response.json(first).json()).toEqual(expected);
      expect(database.prepare("SELECT result_json AS resultJson FROM idempotency_records").get())
        .toEqual({
          resultJson: "{\"kind\":\"report_ack\",\"reportId\":\"safe-report\",\"status\":\"DRAFT\",\"version\":1}",
        });
      expect(JSON.stringify([first, replay])).not.toContain(internalId);
    } finally {
      if (toJsonDescriptor) Object.defineProperty(Object.prototype, "toJSON", toJsonDescriptor);
      else delete (Object.prototype as { toJSON?: unknown }).toJSON;
      if (pollutedDescriptor) {
        Object.defineProperty(Object.prototype, "pollutedAckValue", pollutedDescriptor);
      } else {
        delete (Object.prototype as { pollutedAckValue?: unknown }).pollutedAckValue;
      }
    }
  });

  it("拒绝 own toJSON、getter、非枚举和 symbol 扩展属性", () => {
    testDatabase = createTestDatabase();
    const { repository } = testDatabase;
    const instance = repository.createDemoInstance();
    const base = { kind: "report_ack", reportId: "safe", status: "DRAFT", version: 1 };
    const getter = { ...base };
    Object.defineProperty(getter, "extra", { enumerable: true, get: () => "unsafe" });
    const nonEnumerable = { ...base };
    Object.defineProperty(nonEnumerable, "extra", { enumerable: false, value: "unsafe" });
    const symbol = { ...base, [Symbol("extra")]: "unsafe" };
    const ownToJson = { ...base, toJSON: () => base };

    for (const [index, result] of [getter, nonEnumerable, symbol, ownToJson].entries()) {
      expect(() => repository.runIdempotent({
        demoInstanceId: instance.demoInstanceId,
        actorId: "claimant-demo",
        action: "draft_create",
        idempotencyKey: `prototype-extension-${index}`,
        requestFingerprint: `prototype-extension-${index}`,
      }, () => result as never)).toThrow(expect.objectContaining({ code: "VALIDATION_FAILED" }));
    }
  });

  it("输入校验和输出构造都不触发 inherited acknowledgement 访问器", async () => {
    testDatabase = createTestDatabase();
    const { repository, database } = testDatabase;
    const instance = repository.createDemoInstance();
    const internalId = repository.listServerInternalFoundItems(instance.demoInstanceId)[0]!.inventoryItemId;
    const keys = ["kind", "reportId", "claimId", "status", "version"] as const;
    const original = new Map(keys.map((key) => [
      key,
      Object.getOwnPropertyDescriptor(Object.prototype, key),
    ]));
    const getterCalls = Object.fromEntries(keys.map((key) => [key, 0])) as Record<typeof keys[number], number>;
    const setterCalls = Object.fromEntries(keys.map((key) => [key, 0])) as Record<typeof keys[number], number>;
    const inheritedValues: Record<typeof keys[number], unknown> = {
      kind: "report_ack",
      reportId: internalId,
      claimId: internalId,
      status: "DRAFT",
      version: 1,
    };
    let invalidError: unknown;
    let reportFirst: unknown;
    let reportReplay: unknown;
    let claimFirst: unknown;
    let claimReplay: unknown;
    let stored: unknown;
    try {
      for (const key of keys) {
        Object.defineProperty(Object.prototype, key, {
          configurable: true,
          get() {
            getterCalls[key] += 1;
            return inheritedValues[key];
          },
          set() {
            setterCalls[key] += 1;
          },
        });
      }
      try {
        repository.runIdempotent({
          demoInstanceId: instance.demoInstanceId,
          actorId: "claimant-demo",
          action: "draft_create",
          idempotencyKey: "accessor-invalid",
          requestFingerprint: "accessor-invalid",
        }, () => ({} as never));
      } catch (error) {
        invalidError = error;
      }
      const reportRequest = {
        demoInstanceId: instance.demoInstanceId,
        actorId: "claimant-demo",
        action: "draft_create",
        idempotencyKey: "accessor-report",
        requestFingerprint: "accessor-report",
      } as const;
      reportFirst = repository.runIdempotent(reportRequest, () => ({
        kind: "report_ack", reportId: "safe-report", status: "DRAFT", version: 1,
      }));
      reportReplay = repository.runIdempotent(reportRequest, () => {
        throw new Error("must not replay");
      });
      const claimRequest = {
        ...reportRequest,
        action: "claim_stage",
        idempotencyKey: "accessor-claim",
        requestFingerprint: "accessor-claim",
      } as const;
      claimFirst = repository.runIdempotent(claimRequest, () => ({
        kind: "claim_ack", claimId: "safe-claim", status: "EVIDENCE_REQUIRED", version: 1,
      }));
      claimReplay = repository.runIdempotent(claimRequest, () => {
        throw new Error("must not replay");
      });
      stored = database.prepare(`
        SELECT action, result_json AS resultJson FROM idempotency_records ORDER BY action
      `).all();
    } finally {
      for (const key of keys) {
        const descriptor = original.get(key);
        if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
        else delete (Object.prototype as Record<string, unknown>)[key];
      }
    }
    const reportJson = JSON.stringify(reportFirst);
    const reportResponse = await Response.json(reportFirst).json();
    const reportSpread = { ...(reportFirst as object) };
    const reportClone = structuredClone(reportFirst);

    const reportExpected = {
      kind: "report_ack", reportId: "safe-report", status: "DRAFT", version: 1,
    };
    const claimExpected = {
      kind: "claim_ack", claimId: "safe-claim", status: "EVIDENCE_REQUIRED", version: 1,
    };
    expect(invalidError).toMatchObject({ code: "VALIDATION_FAILED" });
    expect(getterCalls).toEqual(Object.fromEntries(keys.map((key) => [key, 0])));
    expect(setterCalls).toEqual(Object.fromEntries(keys.map((key) => [key, 0])));
    expect(reportFirst).toEqual(reportExpected);
    expect(reportReplay).toEqual(reportExpected);
    expect(claimFirst).toEqual(claimExpected);
    expect(claimReplay).toEqual(claimExpected);
    expect(Object.keys(reportFirst as object)).toEqual(["kind", "reportId", "status", "version"]);
    expect(reportJson).toBe(JSON.stringify(reportExpected));
    expect(reportResponse).toEqual(reportExpected);
    expect(reportSpread).toEqual(reportExpected);
    expect(reportClone).toEqual(reportExpected);
    expect(stored).toEqual([
      { action: "claim_stage", resultJson: JSON.stringify(claimExpected) },
      { action: "draft_create", resultJson: JSON.stringify(reportExpected) },
    ]);
    expect(JSON.stringify([reportFirst, reportReplay, claimFirst, claimReplay])).not.toContain(internalId);
  });
});
