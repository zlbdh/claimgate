import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("post-build evidence client gate wiring", () => {
  it("verify 在 build 后强制执行专用非空 client/raw 扫描", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["check:evidence-client"])
      .toBe("tsx scripts/check-evidence-client.ts");
    expect(packageJson.scripts.verify).toMatch(
      /npm run build && npm run check:evidence-client && npm run check:pickup-client$/,
    );
    expect(existsSync(resolve("scripts/check-evidence-client.ts"))).toBe(true);
  });
});
