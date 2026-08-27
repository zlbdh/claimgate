import type { ClaimGateToolExecutor } from "./tool-types";
import { createReadToolMethods } from "./read-tool-executor";
import { createReportToolMethods } from "./report-tool-executor";
import type { ExecutorOptions } from "./tool-executor-support";

export function createToolExecutor(options: ExecutorOptions = {}): ClaimGateToolExecutor {
  return Object.freeze({
    ...createReportToolMethods(options),
    ...createReadToolMethods(options),
  });
}
