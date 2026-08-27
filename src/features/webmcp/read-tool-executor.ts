import type { ClaimGateToolExecutor } from "./tool-types";
import {
  claimStatusDataSchema,
  pendingClaimsDataSchema,
  pickupInstructionsDataSchema,
  reviewSummaryDataSchema,
} from "./tool-output-schemas";
import {
  INTERNAL_ERROR, baseInit, createScheduler, failureWithStateRefresh, fitItems, readJson,
  type ExecutorOptions,
} from "./tool-executor-support";

function fitReviewTimeline(
  review: ReturnType<typeof reviewSummaryDataSchema.parse>,
) {
  const itemDescription = Array.from(review.item.publicDescription);
  const reportDescription = Array.from(review.report.publicDescription);
  let timeline = [...review.timeline];
  const result = () => ({
    ...review,
    item: { ...review.item, publicDescription: itemDescription.join("") },
    report: { ...review.report, publicDescription: reportDescription.join("") },
    timeline,
  });
  const fits = () => JSON.stringify({ ok: true, data: result() }).length <= 1_500;
  while (!fits() && timeline.length > 1) timeline = timeline.slice(1);
  while (!fits() && (itemDescription.length > 1 || reportDescription.length > 1)) {
    const itemCost = JSON.stringify(itemDescription.join("")).length;
    const reportCost = JSON.stringify(reportDescription.join("")).length;
    if (itemCost >= reportCost && itemDescription.length > 1) itemDescription.pop();
    else if (reportDescription.length > 1) reportDescription.pop();
    else itemDescription.pop();
  }
  if (!fits()) timeline = [];
  return result();
}

export function createReadToolMethods(options: ExecutorOptions) {
  const fetcher = options.fetcher ?? fetch;
  const schedule = createScheduler(options);
  const refresh = options.refresh ?? (() => undefined);
  return Object.freeze({
    async getClaimStatus(input: Parameters<ClaimGateToolExecutor["getClaimStatus"]>[0]) {
      try {
        const response = await fetcher(`/api/claims/${input.claimId}`, baseInit("GET"));
        if (!response.ok) return failureWithStateRefresh(response, schedule, refresh);
        const parsed = claimStatusDataSchema.safeParse(await readJson(response));
        if (!parsed.success || parsed.data.claimId !== input.claimId) return INTERNAL_ERROR;
        schedule(refresh);
        return { ok: true as const, data: parsed.data };
      } catch { return INTERNAL_ERROR; }
    },

    async getPickupInstructions(
      input: Parameters<ClaimGateToolExecutor["getPickupInstructions"]>[0],
    ) {
      try {
        const response = await fetcher(
          `/api/claims/${input.claimId}/pickup-instructions`, baseInit("GET"),
        );
        if (!response.ok) return failureWithStateRefresh(response, schedule, refresh);
        const parsed = pickupInstructionsDataSchema.safeParse(await readJson(response));
        if (!parsed.success || parsed.data.claimId !== input.claimId) return INTERNAL_ERROR;
        schedule(refresh);
        return { ok: true as const, data: parsed.data };
      } catch { return INTERNAL_ERROR; }
    },

    async listPendingClaims(input: Parameters<ClaimGateToolExecutor["listPendingClaims"]>[0]) {
      try {
        const response = await fetcher(
          `/api/staff/claims?limit=${input.limit ?? 3}`, baseInit("GET"),
        );
        if (!response.ok) return failureWithStateRefresh(response, schedule, refresh);
        const parsed = pendingClaimsDataSchema.safeParse(await readJson(response));
        if (!parsed.success) return INTERNAL_ERROR;
        const claims = fitItems(
          parsed.data.claims,
          (items) => ({ ok: true, data: { claims: items } }),
          input.limit ?? 3,
        );
        schedule(refresh);
        return { ok: true as const, data: { claims } };
      } catch { return INTERNAL_ERROR; }
    },

    async getClaimReviewSummary(
      input: Parameters<ClaimGateToolExecutor["getClaimReviewSummary"]>[0],
    ) {
      try {
        const response = await fetcher(`/api/staff/claims/${input.claimId}`, baseInit("GET"));
        if (!response.ok) return failureWithStateRefresh(response, schedule, refresh);
        const parsed = reviewSummaryDataSchema.safeParse(await readJson(response));
        if (!parsed.success || parsed.data.claim.claimId !== input.claimId) return INTERNAL_ERROR;
        schedule(refresh);
        return { ok: true as const, data: fitReviewTimeline(parsed.data) };
      } catch { return INTERNAL_ERROR; }
    },
  });
}
