import { DomainError } from "@/shared/domain-error";
import { mapApiError } from "./api-error";

const SENSITIVE_HEADERS = Object.freeze({
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
});

export function sensitiveJson(value: unknown): Response {
  let body: string;
  try { body = JSON.stringify(value); } catch { throw new DomainError("CONFIGURATION_ERROR"); }
  if (body.length > 1_024) throw new DomainError("CONFIGURATION_ERROR");
  return new Response(body, {
    status: 200,
    headers: { ...SENSITIVE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

export function sensitiveApiError(error: unknown): Response {
  const response = mapApiError(error);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", SENSITIVE_HEADERS["Cache-Control"]);
  headers.set("Referrer-Policy", SENSITIVE_HEADERS["Referrer-Policy"]);
  return new Response(response.body, { status: response.status, headers });
}
