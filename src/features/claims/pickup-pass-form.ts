import { z } from "zod";
import { DomainError } from "@/shared/domain-error";
import type { PickupHandoffCommand, PickupIssuanceCommand } from "./pickup-pass-schema";

const INTEGER = /^[1-9][0-9]*$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/;
const issuanceForm = z.strictObject({
  expectedClaimVersion: z.string().regex(INTEGER),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY),
});
const handoffForm = issuanceForm.omit({ expectedClaimVersion: true }).extend({
  token: z.string().max(64),
  expectedClaimVersion: z.string().regex(INTEGER),
  expectedItemVersion: z.string().regex(INTEGER),
  expectedReportVersion: z.string().regex(INTEGER),
  expectedGeneration: z.string().regex(INTEGER),
});

function record(entries: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const keys = entries.map(([key]) => key);
  if (new Set(keys).size !== keys.length) throw new DomainError("VALIDATION_FAILED");
  return Object.fromEntries(entries);
}

function integer(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new DomainError("VALIDATION_FAILED");
  return parsed;
}

export function parsePickupIssuanceForm(
  entries: ReadonlyArray<readonly [string, string]>,
): PickupIssuanceCommand {
  const parsed = issuanceForm.safeParse(record(entries));
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED");
  return {
    expectedClaimVersion: integer(parsed.data.expectedClaimVersion),
    idempotencyKey: parsed.data.idempotencyKey,
  };
}

export function parsePickupHandoffForm(
  entries: ReadonlyArray<readonly [string, string]>,
): PickupHandoffCommand {
  const parsed = handoffForm.safeParse(record(entries));
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED");
  return {
    token: parsed.data.token,
    expectedClaimVersion: integer(parsed.data.expectedClaimVersion),
    expectedItemVersion: integer(parsed.data.expectedItemVersion),
    expectedReportVersion: integer(parsed.data.expectedReportVersion),
    expectedGeneration: integer(parsed.data.expectedGeneration),
    idempotencyKey: parsed.data.idempotencyKey,
  };
}
