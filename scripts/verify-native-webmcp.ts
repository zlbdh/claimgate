import { chromium } from "@playwright/test";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100";

async function main() {
const nonce = `native-${Date.now()}`;
const browser = await chromium.launch({
  headless: true,
  args: ["--enable-features=WebMCPTesting"],
});

try {
  const page = await browser.newPage();
  await page.goto(`${baseURL}/webmcp-probe`);
  await page.getByText("Native WebMCP probe registered").waitFor();

  const invocation = await page.evaluate(async (callerNonce) => {
    type ToolDescriptor = { name: string };
    type TestingContext = {
      executeTool(tool: ToolDescriptor, input: string): Promise<unknown>;
      getTools(): Promise<ToolDescriptor[]>;
    };

    const context = document.modelContext as TestingContext | undefined;
    if (!context) return { supported: false as const };

    const tools = await context.getTools();
    const probe = tools.find((tool) => tool.name === "claimgate_compatibility_probe");
    if (!probe) {
      return { supported: true as const, toolNames: tools.map((tool) => tool.name) };
    }

    const result = await context.executeTool(
      probe,
      JSON.stringify({ nonce: callerNonce }),
    );
    return {
      supported: true as const,
      toolNames: tools.map((tool) => tool.name),
      result,
    };
  }, nonce);

  await page.evaluate(() => {
    const context = document.modelContext as
      | { addEventListener(type: string, listener: () => void): void }
      | undefined;
    document.documentElement.dataset.webmcpToolChanges = "0";
    context?.addEventListener("toolchange", () => {
      const current = Number(document.documentElement.dataset.webmcpToolChanges);
      document.documentElement.dataset.webmcpToolChanges = String(current + 1);
    });
  });
  await page.getByRole("link", { name: "Return to ClaimGate desk" }).click();
  await page.waitForURL(`${baseURL}/`);
  await page.waitForFunction(async () => {
    const context = document.modelContext as
      | { getTools(): Promise<Array<{ name: string }>> }
      | undefined;
    return context
      ? !(await context.getTools()).some(
          (tool) => tool.name === "claimgate_compatibility_probe",
        )
      : false;
  });
  const toolsAfterTeardown = await page.evaluate(async () => {
    const context = document.modelContext as
      | { getTools(): Promise<Array<{ name: string }>> }
      | undefined;
    return {
      toolNames: context ? (await context.getTools()).map((tool) => tool.name) : null,
      toolChangeCount: Number(
        document.documentElement.dataset.webmcpToolChanges ?? "0",
      ),
    };
  });

  const evidence = {
    checkedAt: new Date().toISOString(),
    browserVersion: browser.version(),
    flag: "--enable-features=WebMCPTesting",
    registration: "document.modelContext.registerTool(tool, { signal })",
    nonce,
    invocation,
    toolsAfterTeardown,
  };
  console.log(JSON.stringify(evidence, null, 2));

  const rawResult =
    invocation.supported && "result" in invocation ? invocation.result : null;
  const result =
    typeof rawResult === "string" ? (JSON.parse(rawResult) as unknown) : rawResult;
  const validResult =
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === true &&
    "nonce" in result &&
    result.nonce === nonce &&
    "api" in result &&
    result.api === "document.modelContext";
  const removed = !toolsAfterTeardown.toolNames?.includes(
    "claimgate_compatibility_probe",
  );

  if (!validResult || !removed) process.exitCode = 1;
} finally {
  await browser.close();
}
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
