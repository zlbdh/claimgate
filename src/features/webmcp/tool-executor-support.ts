import { z } from "zod";
import { TOOL_ERROR_CODES, canonicalToolFailure } from "./tool-errors";
import type { ToolResult } from "./tool-types";
import type { BrowserCandidateDto } from "@/features/reports/report-types";

export type ExecutorOptions = Readonly<{
  fetcher?: typeof fetch;
  createCsrfToken?: string;
  updateCsrfToken?: string;
  stageCsrfToken?: string;
  defer?: (callback: () => void) => void;
  navigate?: (path: string) => void;
  refresh?: () => void;
  publishCandidates?: (
    reportId: string,
    reportVersion: number,
    candidates: readonly BrowserCandidateDto[],
  ) => void;
  clearCandidates?: (reportId: string) => void;
  isCurrent?: () => boolean;
}>;

const errorResponse = z.strictObject({
  error: z.strictObject({
    code: z.enum(TOOL_ERROR_CODES),
    message: z.string().min(1).max(256),
  }),
});
export const INTERNAL_ERROR = Object.freeze(canonicalToolFailure("INTERNAL_ERROR"));
const MAX_RESPONSE_BYTES = 65_536;

export async function readJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (
    !/^(0|[1-9][0-9]*)$/.test(declared)
    || !Number.isSafeInteger(Number(declared))
    || Number(declared) > MAX_RESPONSE_BYTES
  )) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("response too large");
  }
  if (!response.body) throw new Error("response body missing");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  let complete = false;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error("response too large");
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
    complete = true;
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(text) as unknown;
}

export async function failure(response: Response): Promise<ToolResult<never>> {
  try {
    const parsed = errorResponse.safeParse(await readJson(response));
    if (!parsed.success) return INTERNAL_ERROR;
    const retry = response.headers.get("retry-after");
    const seconds = retry && /^[1-9][0-9]{0,4}$/.test(retry) && Number(retry) <= 86_400
      ? Number(retry) : undefined;
    return canonicalToolFailure(parsed.data.error.code, seconds);
  } catch { return INTERNAL_ERROR; }
}

export async function failureWithStateRefresh(
  response: Response,
  schedule: (effect: () => void) => void,
  refresh: () => void,
): Promise<ToolResult<never>> {
  const result = await failure(response);
  if (!result.ok && result.error.code === "STATE_CHANGED") schedule(refresh);
  return result;
}

export function baseInit(method: "GET" | "POST"): RequestInit {
  return {
    method,
    mode: "same-origin",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
  };
}

export function createScheduler(options: ExecutorOptions) {
  const defer = options.defer ?? ((callback: () => void) => setTimeout(callback, 0));
  const isCurrent = options.isCurrent ?? (() => true);
  return (effect: () => void): void => {
    try {
      defer(() => {
        try { if (isCurrent()) effect(); }
        catch { /* Confirmed HTTP success cannot be rewritten by a UI effect. */ }
      });
    } catch { /* Scheduler failure leaves the confirmed envelope unchanged. */ }
  };
}

export function fitItems<T>(
  values: readonly T[],
  envelope: (items: readonly T[]) => unknown,
  max = values.length,
): T[] {
  const result: T[] = [];
  for (const value of values.slice(0, max)) {
    const next = [...result, value];
    if (JSON.stringify(envelope(next)).length > 1_500) break;
    result.push(value);
  }
  return result;
}
