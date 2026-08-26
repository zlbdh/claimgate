export const DOMAIN_ERROR_CODES = Object.freeze([
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
] as const);

export type DomainErrorCode = (typeof DOMAIN_ERROR_CODES)[number];

const publicMessages: Readonly<Record<DomainErrorCode, string>> = Object.freeze({
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
});

export type DomainErrorJson = {
  error: { code: DomainErrorCode; message: string };
};

export class DomainError extends Error {
  #code!: DomainErrorCode;

  constructor(code: DomainErrorCode) {
    super("Domain error");
    this.name = "DomainError";
    Object.setPrototypeOf(this, DomainError.prototype);
    if (!Object.prototype.hasOwnProperty.call(publicMessages, code)) {
      throw new TypeError("Invalid domain error code");
    }
    this.#code = code;
    this.message = publicMessages[code];
    Object.freeze(this);
  }

  get code(): DomainErrorCode {
    return this.#code;
  }

  toJSON(): DomainErrorJson {
    const code = this.#code;
    return { error: { code, message: publicMessages[code] } };
  }
}
