export type SecurityHeader = Readonly<{ key: string; value: string }>;

const GLOBAL_SECURITY_HEADERS = Object.freeze([
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=(), tools=(self)",
  },
] satisfies SecurityHeader[]);

const SENSITIVE_RESPONSE_HEADERS = Object.freeze([
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "private, no-store" },
] satisfies SecurityHeader[]);

function copyHeaders(headers: readonly SecurityHeader[]): Array<{ key: string; value: string }> {
  return headers.map(({ key, value }) => ({ key, value }));
}

export function createGlobalSecurityHeaders() {
  return copyHeaders(GLOBAL_SECURITY_HEADERS);
}

export function createSensitiveResponseHeaders() {
  return copyHeaders(SENSITIVE_RESPONSE_HEADERS);
}

export function createContentSecurityPolicy(
  nonce: string,
  environment = process.env.NODE_ENV,
): string {
  const developmentEval = environment === "development" ? " 'unsafe-eval'" : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${developmentEval}`,
    `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}
