import { DomainError } from "./domain-error";

export type AppOrigin = Readonly<{
  origin: string;
  protocol: "http:" | "https:";
  hostname: string;
  port: string;
  host: string;
}>;

export function parseCanonicalAppOrigin(value: string | undefined): AppOrigin {
  if (!value || value.trim() !== value) throw new DomainError("CONFIGURATION_ERROR");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:")
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== ""
    || parsed.origin !== value
  ) {
    throw new DomainError("CONFIGURATION_ERROR");
  }
  return Object.freeze({
    origin: parsed.origin,
    protocol: parsed.protocol,
    hostname: parsed.hostname,
    port: parsed.port,
    host: parsed.host,
  });
}
