import { DomainError } from "@/shared/domain-error";

const MAX_RAW_CODE_UNITS = 512;
const MAX_NORMALIZED_CODE_UNITS = 256;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;
const DASH_VARIANTS = /\p{Dash}/gu;
const WHITESPACE = /\p{White_Space}+/gu;

function invalid(): never {
  throw new DomainError("VALIDATION_FAILED");
}

export function normalizeEvidence(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_RAW_CODE_UNITS
    || !value.isWellFormed()
    || CONTROL_OR_FORMAT.test(value)
  ) invalid();

  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(DASH_VARIANTS, "-")
    .replace(WHITESPACE, " ");

  if (
    normalized.length === 0
    || normalized.length > MAX_NORMALIZED_CODE_UNITS
    || !normalized.isWellFormed()
    || CONTROL_OR_FORMAT.test(normalized)
  ) invalid();
  return normalized;
}
