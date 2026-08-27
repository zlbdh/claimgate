export const compatibilityProbeTool: WebMCPTool = {
  name: "claimgate_compatibility_probe",
  description:
    "Verify that ClaimGate can receive a WebMCP call and echo a caller nonce without reading or changing product data.",
  inputSchema: {
    type: "object",
    properties: {
      nonce: {
        type: "string",
        description: "Unique caller value that ClaimGate returns unchanged.",
      },
    },
    required: ["nonce"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    untrustedContentHint: false,
  },
  async execute(input) {
    return {
      ok: true,
      nonce: input.nonce,
      api: "document.modelContext",
    };
  },
};

export async function registerCompatibilityProbe(
  context: WebMCPModelContext,
  signal: AbortSignal,
) {
  await context.registerTool(compatibilityProbeTool, { signal });
}
