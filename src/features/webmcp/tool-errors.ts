export const TOOL_ERROR_CODES = Object.freeze([
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "VALIDATION_FAILED",
  "STATE_CHANGED",
  "NOT_FOUND",
  "RATE_LIMITED",
  "ITEM_UNAVAILABLE",
  "CONFLICT",
  "INVALID_STATE_TRANSITION",
  "CONFIGURATION_ERROR",
  "INTERNAL_ERROR",
] as const);

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

export const TOOL_ERROR_MESSAGES = Object.freeze({
  AUTH_REQUIRED: "Authentication is required.",
  FORBIDDEN: "You are not allowed to perform this action.",
  VALIDATION_FAILED: "The submitted data is invalid.",
  STATE_CHANGED: "The resource state has changed.",
  NOT_FOUND: "The requested resource was not found.",
  RATE_LIMITED: "Too many requests. Please try again later.",
  ITEM_UNAVAILABLE: "The item is not available.",
  CONFLICT: "The request conflicts with the current resource state.",
  INVALID_STATE_TRANSITION: "The requested state transition is not allowed.",
  CONFIGURATION_ERROR: "The service is not configured correctly.",
  INTERNAL_ERROR: "Internal server error.",
} satisfies Readonly<Record<ToolErrorCode, string>>);

const codeSet = new Set<string>(TOOL_ERROR_CODES);

export type CanonicalToolError = Readonly<{
  code: ToolErrorCode;
  message: string;
  retryAfterSeconds?: number;
}>;

export function isToolErrorCode(value: unknown): value is ToolErrorCode {
  return typeof value === "string" && codeSet.has(value);
}

export function canonicalToolFailure(
  code: ToolErrorCode,
  retryAfterSeconds?: number,
): Readonly<{ ok: false; error: CanonicalToolError }> {
  const retry = code === "RATE_LIMITED"
    && Number.isSafeInteger(retryAfterSeconds)
    && Number(retryAfterSeconds) >= 1
    && Number(retryAfterSeconds) <= 86_400
    ? { retryAfterSeconds }
    : {};
  return {
    ok: false,
    error: { code, message: TOOL_ERROR_MESSAGES[code], ...retry },
  };
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => typeof key === "string" && allowed.includes(key))
    && keys.length === allowed.filter((key) => Object.hasOwn(value, key)).length;
}

export function sanitizeToolFailure(value: unknown): Readonly<{ ok: false; error: CanonicalToolError }> {
  const internal = () => canonicalToolFailure("INTERNAL_ERROR");
  if (!isPlain(value) || value.ok !== false || !exactKeys(value, ["ok", "error"])) return internal();
  if (!isPlain(value.error) || !exactKeys(value.error, ["code", "message", "retryAfterSeconds"])) {
    return internal();
  }
  const { code, message, retryAfterSeconds } = value.error;
  if (!isToolErrorCode(code) || typeof message !== "string") return internal();
  if (retryAfterSeconds !== undefined) {
    if (
      code !== "RATE_LIMITED"
      || !Number.isSafeInteger(retryAfterSeconds)
      || Number(retryAfterSeconds) < 1
      || Number(retryAfterSeconds) > 86_400
    ) return internal();
  }
  return canonicalToolFailure(code, retryAfterSeconds as number | undefined);
}
