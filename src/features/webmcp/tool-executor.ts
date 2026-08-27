import { z } from "zod";
import type { ClaimGateToolExecutor, ToolResult } from "./tool-contracts";
import {
  TOOL_ERROR_CODES,
  canonicalToolFailure,
} from "./tool-errors";

const reportStatus = z.enum(["DRAFT", "PUBLISHED", "RESOLVED", "ARCHIVED"]);
const publicReport = z.strictObject({
  reportId: z.string().min(1).max(128), category: z.string().min(1).max(64),
  timeWindow: z.strictObject({ from: z.string().max(64), to: z.string().max(64) }),
  area: z.string().min(1).max(64), color: z.string().min(1).max(64),
  publicTags: z.array(z.string().min(1).max(64)).max(8),
  publicDescription: z.string().min(1).max(256), status: reportStatus,
  version: z.number().int().safe().positive(),
});
const candidate = z.strictObject({
  candidateHandle: z.string().regex(/^cgch1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.[A-Za-z0-9_-]{43}$/),
  category: z.string().min(1).max(64), timeBand: z.string().min(1).max(64),
  area: z.string().min(1).max(64), color: z.string().min(1).max(64),
  confidence: z.enum(["strong", "possible", "weak"]),
  reasons: z.array(z.string().min(1).max(160)).max(8),
  expiresAt: z.number().int().safe().positive(),
});
const knownErrorCode = z.enum(TOOL_ERROR_CODES);
const errorResponse = z.strictObject({
  error: z.strictObject({ code: knownErrorCode, message: z.string().min(1).max(256) }),
});
const INTERNAL_ERROR = Object.freeze(canonicalToolFailure("INTERNAL_ERROR"));

type ExecutorOptions = Readonly<{
  fetcher?: typeof fetch;
  createCsrfToken?: string;
  stageCsrfToken?: string;
  defer?: (callback: () => void) => void;
  navigate?: (path: string) => void;
  publishCandidates?: (reportId: string, reportVersion: number, candidates: readonly z.infer<typeof candidate>[]) => void;
  isCurrent?: () => boolean;
}>;

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 65_536) throw new Error("response too large");
  return JSON.parse(text) as unknown;
}

async function failure(response: Response): Promise<ToolResult<never>> {
  try {
    const parsed = errorResponse.safeParse(await readJson(response));
    if (!parsed.success) return INTERNAL_ERROR;
    const retry = response.headers.get("retry-after");
    const retryAfterSeconds = retry && /^[1-9][0-9]{0,4}$/.test(retry) && Number(retry) <= 86_400
      ? Number(retry)
      : undefined;
    return canonicalToolFailure(parsed.data.error.code, retryAfterSeconds);
  } catch {
    return INTERNAL_ERROR;
  }
}

function baseInit(method: "GET" | "POST"): RequestInit {
  return {
    method,
    mode: "same-origin",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers: { Accept: "application/json" },
  };
}

export function createToolExecutor(options: ExecutorOptions = {}): ClaimGateToolExecutor {
  const fetcher = options.fetcher ?? fetch;
  const defer = options.defer ?? ((callback) => setTimeout(callback, 0));
  const navigate = options.navigate ?? (() => undefined);
  const publishCandidates = options.publishCandidates ?? (() => undefined);
  const isCurrent = options.isCurrent ?? (() => true);
  const schedule = (effect: () => void): void => {
    try {
      defer(() => {
        try {
          if (isCurrent()) effect();
        } catch {
          // A post-result UI effect cannot rewrite or reject a confirmed HTTP success.
        }
      });
    } catch {
      // A scheduler failure also leaves the confirmed tool envelope unchanged.
    }
  };

  const executor: ClaimGateToolExecutor = {
    async createDraft(input) {
      if (!options.createCsrfToken) return INTERNAL_ERROR;
      const body = new URLSearchParams({
        category: input.category,
        timeFrom: input.timeWindow.from,
        timeTo: input.timeWindow.to,
        area: input.area,
        color: input.color,
        publicTags: JSON.stringify(input.publicTags),
        publicDescription: input.publicDescription,
        idempotencyKey: input.idempotencyKey,
      });
      try {
        const init = baseInit("POST");
        init.headers = { ...init.headers, "X-CSRF-Token": options.createCsrfToken };
        init.body = body;
        const response = await fetcher("/api/reports", init);
        if (!response.ok) return failure(response);
        const parsed = z.strictObject({
          reportId: z.string().min(1).max(128), status: z.literal("DRAFT"),
          version: z.number().int().safe().positive(),
          nextPath: z.string().startsWith("/claimant/reports/").max(256),
        }).safeParse(await readJson(response));
        if (!parsed.success) return INTERNAL_ERROR;
        const result = { ok: true as const, data: {
          reportId: parsed.data.reportId, status: parsed.data.status, version: parsed.data.version,
        }, nextPath: parsed.data.nextPath };
        schedule(() => navigate(parsed.data.nextPath));
        return result;
      } catch {
        return INTERNAL_ERROR;
      }
    },

    async listReports(input) {
      try {
        const response = await fetcher("/api/reports", baseInit("GET"));
        if (!response.ok) return failure(response);
        const parsed = z.strictObject({ reports: z.array(publicReport).max(50) })
          .safeParse(await readJson(response));
        if (!parsed.success) return INTERNAL_ERROR;
        const reports = parsed.data.reports
          .filter((report) => input.status === undefined || report.status === input.status)
          .slice(0, input.limit ?? 20)
          .map((report) => ({
            reportId: report.reportId,
            category: report.category,
            timeWindow: report.timeWindow,
            area: report.area,
            color: report.color,
            status: report.status,
            version: report.version,
          }));
        return { ok: true, data: { reports } };
      } catch {
        return INTERNAL_ERROR;
      }
    },

    async findCandidates(input) {
      try {
        const response = await fetcher(
          `/api/reports/${input.reportId}/matches?limit=${input.limit ?? 3}`,
          baseInit("GET"),
        );
        if (!response.ok) return failure(response);
        const parsed = z.strictObject({
          reportVersion: z.number().int().safe().positive(),
          candidates: z.array(candidate).max(3),
          message: z.string().min(1).max(256),
        }).safeParse(await readJson(response));
        if (!parsed.success) return INTERNAL_ERROR;
        const result = { ok: true as const, data: parsed.data };
        schedule(() => publishCandidates(input.reportId, parsed.data.reportVersion, parsed.data.candidates));
        return result;
      } catch {
        return INTERNAL_ERROR;
      }
    },

    async stageClaim(input) {
      if (!options.stageCsrfToken) return INTERNAL_ERROR;
      try {
        const init = baseInit("POST");
        init.headers = {
          ...init.headers,
          "Content-Type": "application/json",
          "X-CSRF-Token": options.stageCsrfToken,
        };
        init.body = JSON.stringify(input);
        const response = await fetcher("/api/claims", init);
        if (!response.ok) return failure(response);
        const parsed = z.strictObject({
          claimId: z.string().min(1).max(128), status: z.literal("EVIDENCE_REQUIRED"),
          version: z.number().int().safe().positive(), remainingAttempts: z.literal(3),
          nextPath: z.string().startsWith("/claimant/claims/").max(256),
        }).safeParse(await readJson(response));
        if (!parsed.success) return INTERNAL_ERROR;
        const { nextPath, ...data } = parsed.data;
        const result = { ok: true as const, data, nextPath };
        schedule(() => navigate(nextPath));
        return result;
      } catch {
        return INTERNAL_ERROR;
      }
    },
  };
  return Object.freeze(executor);
}
