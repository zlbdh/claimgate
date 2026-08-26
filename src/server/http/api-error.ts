import { DomainError, type DomainErrorCode } from "@/shared/domain-error";

const HTTP_STATUS: Readonly<Record<DomainErrorCode, number>> = Object.freeze({
  AUTH_REQUIRED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  STATE_CHANGED: 409,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  ITEM_UNAVAILABLE: 409,
  CONFLICT: 409,
  INVALID_STATE_TRANSITION: 409,
  CONFIGURATION_ERROR: 500,
});

class BoundedRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterMs: number) {
    super("Rate limited");
    this.name = "BoundedRateLimitError";
    this.retryAfterSeconds = Math.min(86_400, Math.max(1, Math.ceil(retryAfterMs / 1_000)));
  }
}

export function throwRateLimited(retryAfterMs: number): never {
  if (!Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0 || retryAfterMs > 86_400_000) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  throw new BoundedRateLimitError(retryAfterMs);
}

export function mapApiError(error: unknown): Response {
  if (error instanceof BoundedRateLimitError) {
    const domainError = new DomainError("RATE_LIMITED");
    return Response.json(domainError.toJSON(), {
      status: 429,
      headers: {
        "Cache-Control": "private, no-store",
        "Retry-After": String(error.retryAfterSeconds),
      },
    });
  }
  if (error instanceof DomainError) {
    const headers: Record<string, string> = { "Cache-Control": "private, no-store" };
    if (error.code === "RATE_LIMITED") headers["Retry-After"] = "1";
    return Response.json(error.toJSON(), {
      status: HTTP_STATUS[error.code],
      headers,
    });
  }
  return Response.json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error." },
  }, {
    status: 500,
    headers: { "Cache-Control": "private, no-store" },
  });
}
