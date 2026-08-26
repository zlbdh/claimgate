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
});
