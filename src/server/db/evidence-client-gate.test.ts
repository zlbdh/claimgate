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
    expect(packageJson.scripts["check:secret-surfaces"])
      .toBe("tsx scripts/check-secret-surfaces.ts");
    expect(packageJson.scripts.verify).toMatch(
      /npm run build && npm run check:evidence-client && npm run check:pickup-client && npm run check:secret-surfaces$/,
    );
    expect(existsSync(resolve("scripts/check-evidence-client.ts"))).toBe(true);
    expect(existsSync(resolve("scripts/check-secret-surfaces.ts"))).toBe(true);
    const pickupGate = readFileSync(resolve("scripts/check-pickup-pass-client.ts"), "utf8");
    expect(pickupGate).not.toContain("empty Claim WebMCP set");
    expect(pickupGate).toContain('import { assertPickupSafeWebMcp } from "./pickup-webmcp-gate"');
    expect(pickupGate).toContain("assertPickupSafeWebMcp(toolNames, webMcpSource)");
    expect(existsSync(resolve("scripts/pickup-webmcp-gate.ts"))).toBe(true);
  });
});
