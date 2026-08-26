import { DomainError } from "@/shared/domain-error";
import { parseCanonicalAppOrigin, type AppOrigin } from "@/shared/app-origin";

export const parseAppOrigin = parseCanonicalAppOrigin;

function requireSingleHeader(headers: Headers, name: string): string {
  const value = headers.get(name);
  if (!value || value.trim() !== value || value.includes(",")) {
    throw new DomainError("FORBIDDEN");
  }
  return value;
}

function normalizedHost(value: string, appOrigin: AppOrigin): string {
  let parsed: URL;
  try {
    parsed = new URL(`${appOrigin.protocol}//${value}`);
  } catch {
    throw new DomainError("FORBIDDEN");
  }
  if (
    parsed.username || parsed.password || parsed.pathname !== "/"
    || parsed.search || parsed.hash || value.includes("/") || value.includes("@")
  ) throw new DomainError("FORBIDDEN");
  return parsed.host;
}

export function requireConfiguredHost(headers: Headers, appOrigin: AppOrigin): void {
  const host = requireSingleHeader(headers, "host");
  if (normalizedHost(host, appOrigin) !== appOrigin.host) throw new DomainError("FORBIDDEN");
}

function requireOriginAndHost(headers: Headers, appOrigin: AppOrigin): void {
  const origin = requireSingleHeader(headers, "origin");
  if (origin === "null" || origin !== appOrigin.origin) throw new DomainError("FORBIDDEN");
  requireConfiguredHost(headers, appOrigin);
}

export function requireDemoStartOrigin(headers: Headers, appOrigin: AppOrigin): void {
  requireOriginAndHost(headers, appOrigin);
  if (requireSingleHeader(headers, "sec-fetch-site") !== "same-origin") {
    throw new DomainError("FORBIDDEN");
  }
}

export function requireAuthenticatedWriteOrigin(headers: Headers, appOrigin: AppOrigin): void {
  requireOriginAndHost(headers, appOrigin);
  const fetchSite = headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") throw new DomainError("FORBIDDEN");
}
