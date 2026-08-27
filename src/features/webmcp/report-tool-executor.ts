import { z } from "zod";
import { candidateSearchSchema } from "@/features/reports/candidate-response-schema";
import { reportSummarySchema } from "./tool-output-schemas";
import type { ClaimGateToolExecutor, CandidateToolDto } from "./tool-types";
import {
  INTERNAL_ERROR, baseInit, createScheduler, failure, failureWithStateRefresh, fitItems, readJson,
  type ExecutorOptions,
} from "./tool-executor-support";

const publicId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);

function updateBody(input: Parameters<ClaimGateToolExecutor["updateDraft"]>[0]) {
  const body = new URLSearchParams({
    expectedVersion: String(input.expectedVersion),
    idempotencyKey: input.idempotencyKey,
  });
  for (const field of ["category", "area", "color", "publicDescription"] as const) {
    const value = input.patch[field];
    if (value !== undefined) body.set(field, value);
  }
  if (input.patch.publicTags !== undefined) {
    body.set("publicTags", JSON.stringify(input.patch.publicTags));
  }
  if (input.patch.timeWindow !== undefined) {
    body.set("timeFrom", input.patch.timeWindow.from);
    body.set("timeTo", input.patch.timeWindow.to);
  }
  return body;
}

function fitCandidates(
  reportVersion: number,
  candidates: readonly CandidateToolDto[],
  message: string,
) {
  const accepted: CandidateToolDto[] = [];
  for (const candidate of candidates) {
    const reasons = fitItems(candidate.reasons, (items) => ({
      ok: true,
      data: { reportVersion, candidates: [...accepted, { ...candidate, reasons: items }], message },
    }));
    const next = { ...candidate, reasons };
    if (JSON.stringify({ ok: true, data: {
      reportVersion, candidates: [...accepted, next], message,
    } }).length > 1_500) break;
    accepted.push(next);
  }
  return accepted;
}

export function createReportToolMethods(options: ExecutorOptions) {
  const fetcher = options.fetcher ?? fetch;
  const schedule = createScheduler(options);
  const navigate = options.navigate ?? (() => undefined);
  const refresh = options.refresh ?? (() => undefined);
  const publishCandidates = options.publishCandidates ?? (() => undefined);
  const clearCandidates = options.clearCandidates ?? (() => undefined);
  const invalidateCandidates = (reportId: string, refreshPage: boolean): void => {
    schedule(() => {
      clearCandidates(reportId);
      if (refreshPage) refresh();
    });
  };
  const refreshesCandidateState = (code: string | undefined): boolean => [
    "STATE_CHANGED", "ITEM_UNAVAILABLE", "CONFLICT", "INVALID_STATE_TRANSITION", "NOT_FOUND",
  ].includes(code ?? "");

  return Object.freeze({
    async createDraft(input: Parameters<ClaimGateToolExecutor["createDraft"]>[0]) {
      if (!options.createCsrfToken) return INTERNAL_ERROR;
      const body = new URLSearchParams({
        category: input.category, timeFrom: input.timeWindow.from, timeTo: input.timeWindow.to,
        area: input.area, color: input.color, publicTags: JSON.stringify(input.publicTags),
        publicDescription: input.publicDescription, idempotencyKey: input.idempotencyKey,
      });
      try {
        const init = baseInit("POST");
        init.headers = { ...init.headers, "X-CSRF-Token": options.createCsrfToken };
        init.body = body;
        const response = await fetcher("/api/reports", init);
        if (!response.ok) return failureWithStateRefresh(response, schedule, refresh);
        const parsed = z.strictObject({
          reportId: publicId, status: z.literal("DRAFT"),
          version: z.number().int().safe().positive(),
          nextPath: z.string().startsWith("/claimant/reports/").max(256),
        }).safeParse(await readJson(response));
        if (
          !parsed.success
          || parsed.data.nextPath !== `/claimant/reports/${parsed.data.reportId}`
        ) return INTERNAL_ERROR;
        const { nextPath, ...data } = parsed.data;
        schedule(() => navigate(nextPath));
        return { ok: true as const, data, nextPath };
      } catch { return INTERNAL_ERROR; }
    },

    async updateDraft(input: Parameters<ClaimGateToolExecutor["updateDraft"]>[0]) {
      if (!options.updateCsrfToken) return INTERNAL_ERROR;
      try {
        const init = baseInit("POST");
        init.headers = { ...init.headers, "X-CSRF-Token": options.updateCsrfToken };
        init.body = updateBody(input);
        const response = await fetcher(`/api/reports/${input.reportId}`, init);
        if (!response.ok) return failureWithStateRefresh(response, schedule, refresh);
        const parsed = z.strictObject({
          reportId: z.literal(input.reportId), status: z.literal("DRAFT"),
          version: z.number().int().safe().positive(),
          nextPath: z.literal(`/claimant/reports/${input.reportId}`),
        }).safeParse(await readJson(response));
        if (!parsed.success) return INTERNAL_ERROR;
        schedule(refresh);
        return { ok: true as const, data: {
          reportId: parsed.data.reportId, status: parsed.data.status, version: parsed.data.version,
        } };
      } catch { return INTERNAL_ERROR; }
    },

    async listReports(input: Parameters<ClaimGateToolExecutor["listReports"]>[0]) {
      try {
        const query = new URLSearchParams();
        if (input.status !== undefined) query.set("status", input.status);
        query.set("limit", String(input.limit ?? 20));
        const response = await fetcher(`/api/reports?${query}`, baseInit("GET"));
        if (!response.ok) return failure(response);
        const parsed = z.strictObject({ reports: z.array(reportSummarySchema).max(20) })
          .safeParse(await readJson(response));
        if (!parsed.success) return INTERNAL_ERROR;
        const reports = fitItems(
          parsed.data.reports,
          (items) => ({ ok: true, data: { reports: items } }),
        );
        return { ok: true as const, data: { reports } };
      } catch { return INTERNAL_ERROR; }
    },

    async findCandidates(input: Parameters<ClaimGateToolExecutor["findCandidates"]>[0]) {
      try {
        const response = await fetcher(
          `/api/reports/${input.reportId}/matches?limit=${input.limit ?? 3}`,
          baseInit("GET"),
        );
        if (!response.ok) {
          const result = await failure(response);
          invalidateCandidates(
            input.reportId,
            !result.ok && refreshesCandidateState(result.error.code),
          );
          return result;
        }
        const parsed = candidateSearchSchema.safeParse(await readJson(response));
        if (!parsed.success) {
          invalidateCandidates(input.reportId, false);
          return INTERNAL_ERROR;
        }
        const candidates = fitCandidates(
          parsed.data.reportVersion, parsed.data.candidates, parsed.data.message,
        );
        const data = { ...parsed.data, candidates };
        schedule(() => publishCandidates(input.reportId, data.reportVersion, data.candidates));
        return { ok: true as const, data };
      } catch {
        invalidateCandidates(input.reportId, false);
        return INTERNAL_ERROR;
      }
    },

    async stageClaim(input: Parameters<ClaimGateToolExecutor["stageClaim"]>[0]) {
      if (!options.stageCsrfToken) return INTERNAL_ERROR;
      try {
        const init = baseInit("POST");
        init.headers = { ...init.headers, "Content-Type": "application/json",
          "X-CSRF-Token": options.stageCsrfToken };
        init.body = JSON.stringify(input);
        const response = await fetcher("/api/claims", init);
        if (!response.ok) {
          const result = await failure(response);
          invalidateCandidates(
            input.reportId,
            !result.ok && refreshesCandidateState(result.error.code),
          );
          return result;
        }
        const parsed = z.strictObject({
          claimId: publicId, status: z.literal("EVIDENCE_REQUIRED"),
          version: z.number().int().safe().positive(), remainingAttempts: z.literal(3),
          nextPath: z.string().startsWith("/claimant/claims/").max(256),
        }).safeParse(await readJson(response));
        if (
          !parsed.success
          || parsed.data.nextPath !== `/claimant/claims/${parsed.data.claimId}`
        ) {
          invalidateCandidates(input.reportId, false);
          return INTERNAL_ERROR;
        }
        const { nextPath, ...data } = parsed.data;
        schedule(() => navigate(nextPath));
        return { ok: true as const, data, nextPath };
      } catch {
        invalidateCandidates(input.reportId, false);
        return INTERNAL_ERROR;
      }
    },
  });
}
