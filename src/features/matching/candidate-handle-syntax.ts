import { z } from "zod";

export const CANDIDATE_HANDLE_VERSION = "cgch1";
export const CANDIDATE_HANDLE_MAX_LENGTH = 96;
export const CANDIDATE_HANDLE_MAX_LIFETIME_SECONDS = 900;
export const CANDIDATE_HANDLE_PATTERN_SOURCE =
  "^cgch1\\.(?:0|[1-9][0-9]{0,15})\\.(?:0|[1-9][0-9]{0,15})\\.[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$";

const candidateHandlePattern = new RegExp(CANDIDATE_HANDLE_PATTERN_SOURCE);
const canonicalInteger = /^(0|[1-9][0-9]*)$/;

export type CandidateHandleSyntax = Readonly<{
  issuedAtSeconds: number;
  expiresAtSeconds: number;
  macText: string;
}>;

function parseInteger(value: string): number | undefined {
  if (!canonicalInteger.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export function parseCandidateHandleSyntax(value: unknown): CandidateHandleSyntax | undefined {
  if (
    typeof value !== "string"
    || value.length > CANDIDATE_HANDLE_MAX_LENGTH
    || !candidateHandlePattern.test(value)
  ) return undefined;
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== CANDIDATE_HANDLE_VERSION) return undefined;
  const issuedAtSeconds = parseInteger(parts[1]!);
  const expiresAtSeconds = parseInteger(parts[2]!);
  if (issuedAtSeconds === undefined || expiresAtSeconds === undefined) return undefined;
  const lifetime = expiresAtSeconds - issuedAtSeconds;
  if (lifetime <= 0 || lifetime > CANDIDATE_HANDLE_MAX_LIFETIME_SECONDS) return undefined;
  return Object.freeze({ issuedAtSeconds, expiresAtSeconds, macText: parts[3]! });
}

export const candidateHandleSchema = z.string()
  .max(CANDIDATE_HANDLE_MAX_LENGTH)
  .refine((value) => parseCandidateHandleSyntax(value) !== undefined);
