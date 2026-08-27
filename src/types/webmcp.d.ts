type WebMCPInput = Record<string, unknown>;

interface WebMCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    untrustedContentHint: boolean;
  };
  execute(input: WebMCPInput): unknown | Promise<unknown>;
}

interface WebMCPModelContext {
  registerTool(
    tool: WebMCPTool,
    options?: { signal?: AbortSignal },
  ): Promise<void>;
}

interface Document {
  readonly modelContext?: WebMCPModelContext;
}
