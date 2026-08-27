import { z } from "zod";
import { DomainError } from "@/shared/domain-error";

const version = z.number().int().safe().positive();
const idempotencyKey = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/);
const issuance = z.strictObject({ expectedClaimVersion: version, idempotencyKey });
const handoff = z.strictObject({
  token: z.string().max(64),
  expectedClaimVersion: version,
  expectedItemVersion: version,
  expectedReportVersion: version,
  expectedGeneration: version,
  idempotencyKey,
});

export type PickupIssuanceCommand = z.infer<typeof issuance>;
export type PickupHandoffCommand = z.infer<typeof handoff>;

export function validatePickupIssuance(value: unknown): PickupIssuanceCommand {
  const parsed = issuance.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED");
  return parsed.data;
}

export function validatePickupHandoff(value: unknown): PickupHandoffCommand {
  const parsed = handoff.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED");
  return parsed.data;
}
