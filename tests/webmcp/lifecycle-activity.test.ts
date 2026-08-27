import { describe, expect, it, vi } from "vitest";
import { createActivityStore } from "@/features/webmcp/activity-store";
import { createToolRegistrationManager } from "@/features/webmcp/tool-registration";

function tool(name: string): WebMCPTool {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: "object", properties: {}, required: [], additionalProperties: false },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute: async () => ({ ok: true, data: {} }),
  };
}

describe("serialized WebMCP registration lifecycle", () => {
  it("survives StrictMode cleanup/remount without duplicate or stale membership", async () => {
    const active = new Map<string, WebMCPTool>();
    const context: WebMCPModelContext = {
      async registerTool(value, options) {
        if (active.has(value.name)) throw new Error("duplicate");
        active.set(value.name, value);
        options?.signal?.addEventListener("abort", () => active.delete(value.name), { once: true });
      },
    };
    const first = createToolRegistrationManager(context);
    const firstReady = first.replace([tool("old")]);
    first.dispose();
    const second = createToolRegistrationManager(context);
    await Promise.all([firstReady, second.replace([tool("new")])]);
    expect([...active.keys()]).toEqual(["new"]);
    second.dispose();
    await second.settled();
    expect(active.size).toBe(0);
  });

  it("rolls back partial registration and ignores a stale generation completion", async () => {
    const active = new Set<string>();
    const states: string[] = [];
    const context: WebMCPModelContext = {
      async registerTool(value, options) {
        active.add(value.name);
        options?.signal?.addEventListener("abort", () => active.delete(value.name), { once: true });
        if (value.name === "broken") throw new Error("native rejection detail");
      },
    };
    const manager = createToolRegistrationManager(context, (state) => states.push(state));
    await manager.replace([tool("partial"), tool("broken")]);
    expect(active.size).toBe(0);
    expect(states.at(-1)).toBe("error");
    await manager.replace([tool("current")]);
    expect([...active]).toEqual(["current"]);
    expect(states.at(-1)).toBe("registered");
  });

  it("does not leak unhandled rejections when registration fails", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const manager = createToolRegistrationManager({
        registerTool: vi.fn(async () => { throw new Error("private native error"); }),
      });
      await manager.replace([tool("one")]);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("bounded redacted Agent activity", () => {
  it("keeps only 20 generic entries and accepts no raw input/output fields", () => {
    let now = 1_000;
    const store = createActivityStore({ now: () => now });
    for (let index = 0; index < 23; index += 1) {
      const finish = store.begin("find_candidate_matches");
      now += 5;
      finish({ success: index % 2 === 0, errorCode: index % 2 ? "STATE_CHANGED" : undefined, stateChange: "Candidate state updated" });
    }
    const entries = store.getSnapshot();
    expect(entries).toHaveLength(20);
    expect(Object.keys(entries[0]!).sort()).toEqual([
      "endedAt", "errorCode", "name", "startedAt", "stateChange", "success",
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/cgch1|cookie|csrf|session|report-public|claim-public|body|output/i);
  });

  it("replaces untrusted error details with a generic bounded code", () => {
    const store = createActivityStore({ now: () => 1_000 });
    const finish = store.begin("stage_claim_candidate");
    finish({ success: false, errorCode: "cgch1.secret-handle", stateChange: "No page change" });
    expect(store.getSnapshot()[0]?.errorCode).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(store.getSnapshot())).not.toContain("secret-handle");
  });
});
