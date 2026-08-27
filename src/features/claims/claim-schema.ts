import { z } from "zod";
import { DomainError } from "@/shared/domain-error";

const stageClaimSchema = z.strictObject({
  reportId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  candidateHandle: z.string().regex(
    /^cgch1\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.[A-Za-z0-9_-]{43}$/,
  ),
  expectedVersion: z.number().int().safe().positive(),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._~-]{15,127}$/),
});

export type StageClaimCommand = z.infer<typeof stageClaimSchema>;

export function validateStageClaimCommand(value: unknown): StageClaimCommand {
  const parsed = stageClaimSchema.safeParse(value);
  if (!parsed.success) throw new DomainError("VALIDATION_FAILED");
  return parsed.data;
}
