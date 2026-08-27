import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("three-run native acceptance evidence wiring", () => {
  it("builds once, runs the verifier three times, and emits only after cleanup", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["accept:native:3"])
      .toBe("npm run build && tsx scripts/run-native-acceptance.ts");
    expect(packageJson.scripts["accept:native:3:clean"])
      .toBe("npm run build && tsx scripts/run-native-acceptance.ts --require-clean");
    expect(existsSync(resolve("scripts/run-native-acceptance.ts"))).toBe(true);
    expect(existsSync(resolve("scripts/native-acceptance-publisher.ts"))).toBe(true);
    const verifier = readFileSync(resolve("scripts/verify-native-webmcp.ts"), "utf8");
    const contract = readFileSync(resolve("scripts/native-acceptance-contract.ts"), "utf8");
    expect(contract).toContain("cleanupVerified: true");
    expect(verifier).toMatch(
      /finally\s*\{[\s\S]*cleanupNativeRun[\s\S]*void main\(\)\.then[\s\S]*finalizeNativeAcceptance[\s\S]*process\.stdout\.write/,
    );
  });
});
