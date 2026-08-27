import { z } from "zod";
import { candidateHandleSchema } from "@/features/matching/candidate-handle-syntax";

export const browserCandidateSchema = z.strictObject({
  candidateHandle: candidateHandleSchema,
  category: z.string().min(1).max(64),
  timeBand: z.string().min(1).max(64),
  area: z.string().min(1).max(64),
  color: z.string().min(1).max(64),
  confidence: z.enum(["strong", "possible", "weak"]),
  reasons: z.array(z.string().min(1).max(160)).max(8),
  expiresAt: z.number().int().safe().positive(),
});

export const candidateListSchema = z.strictObject({
  candidates: z.array(browserCandidateSchema).max(3),
  message: z.string().min(1).max(256),
});

export const candidateSearchSchema = z.strictObject({
  reportVersion: z.number().int().safe().positive(),
  ...candidateListSchema.shape,
});
