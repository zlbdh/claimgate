import type { CreateReportCommand, UpdateReportCommand } from "./report-schema";

function reportFields(input: Omit<CreateReportCommand, "idempotencyKey">) {
  return {
    category: input.category,
    timeWindow: { from: input.timeWindow.from, to: input.timeWindow.to },
    area: input.area,
    color: input.color,
    publicTags: [...input.publicTags],
    publicDescription: input.publicDescription,
  };
}

export function createReportFingerprint(input: CreateReportCommand): string {
  return JSON.stringify({
    contract: "ClaimGate/report-create/v1",
    method: "POST",
    path: "/api/reports",
    report: reportFields(input),
  });
}

export function updateReportFingerprint(
  reportId: string,
  input: UpdateReportCommand,
): string {
  const patch = {
    ...(input.patch.category === undefined ? {} : { category: input.patch.category }),
    ...(input.patch.timeWindow === undefined ? {} : {
      timeWindow: { from: input.patch.timeWindow.from, to: input.patch.timeWindow.to },
    }),
    ...(input.patch.area === undefined ? {} : { area: input.patch.area }),
    ...(input.patch.color === undefined ? {} : { color: input.patch.color }),
    ...(input.patch.publicTags === undefined ? {} : { publicTags: [...input.patch.publicTags] }),
    ...(input.patch.publicDescription === undefined ? {} : {
      publicDescription: input.patch.publicDescription,
    }),
  };
  return JSON.stringify({
    contract: "ClaimGate/report-update/v1",
    method: "POST",
    path: `/api/reports/${reportId}`,
    expectedVersion: input.expectedVersion,
    patch,
  });
}
