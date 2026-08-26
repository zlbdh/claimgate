import { Buffer } from "node:buffer";
import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { createKeyring } from "@/server/security/keyring";
import { initializeDatabase } from "./migrate";
import { createTestDatabase, type TestDatabase } from "./test-harness";

let testDatabase: TestDatabase | undefined;

afterEach(() => {
  testDatabase?.close();
  testDatabase = undefined;
});

describe("database key-check 的精确安全边界", () => {
  it("只检测配置密钥连续性，不加密业务内容，也不证明整库完整性", () => {
    testDatabase = createTestDatabase();
    const instance = testDatabase.repository.createDemoInstance();
    testDatabase.database.prepare(`
      UPDATE found_items SET public_description = 'tampered-public-value'
      WHERE demo_instance_id = ?
    `).run(instance.demoInstanceId);
    testDatabase.database.close();

    expect(readFileSync(testDatabase.databasePath).includes(Buffer.from("tampered-public-value"))).toBe(true);
    const reopened = initializeDatabase({
      databasePath: testDatabase.databasePath,
      keyring: createKeyring(Buffer.alloc(32, 7).toString("base64")),
    });
    expect(reopened.prepare(`
      SELECT COUNT(*) AS count FROM found_items WHERE public_description = 'tampered-public-value'
    `).get()).toEqual({ count: 7 });
    reopened.close();
  });

  it("不能阻止攻击者把文件替换成用另一把密钥初始化的空数据库", () => {
    testDatabase = createTestDatabase();
    testDatabase.database.close();
    rmSync(testDatabase.databasePath, { force: true });
    rmSync(`${testDatabase.databasePath}-wal`, { force: true });
    rmSync(`${testDatabase.databasePath}-shm`, { force: true });

    const replacement = initializeDatabase({
      databasePath: testDatabase.databasePath,
      keyring: createKeyring(Buffer.alloc(32, 9).toString("base64")),
    });
    expect(replacement.prepare("SELECT COUNT(*) AS count FROM demo_instances").get())
      .toEqual({ count: 0 });
    replacement.close();
  });
});
