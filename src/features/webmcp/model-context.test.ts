import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveModelContext } from "./model-context";
import {
  compatibilityProbeTool,
  registerCompatibilityProbe,
} from "./probe-tool";

describe("resolveModelContext", () => {
  afterEach(() => {
    Reflect.deleteProperty(document, "modelContext");
  });

  it("returns unavailable without document.modelContext", () => {
    expect(resolveModelContext(document)).toEqual({ supported: false });
  });

  it("returns the native document.modelContext implementation", () => {
    const registerTool = vi.fn();
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: { registerTool },
    });

    expect(resolveModelContext(document)).toMatchObject({
      supported: true,
      context: { registerTool },
    });
  });
});

describe("compatibilityProbeTool", () => {
  it("declares a read-only native compatibility probe", () => {
    expect(compatibilityProbeTool).toMatchObject({
      name: "claimgate_compatibility_probe",
      annotations: { readOnlyHint: true },
    });
  });

  it("echoes the caller nonce with the native API name", async () => {
    await expect(
      compatibilityProbeTool.execute({ nonce: "day1-native-0826" }),
    ).resolves.toEqual({
      ok: true,
      nonce: "day1-native-0826",
      api: "document.modelContext",
    });
  });

  it("registers with the caller-owned teardown signal", async () => {
    const registerTool = vi.fn();
    const controller = new AbortController();

    await registerCompatibilityProbe({ registerTool }, controller.signal);

    expect(registerTool).toHaveBeenCalledWith(compatibilityProbeTool, {
      signal: controller.signal,
    });
  });
});
