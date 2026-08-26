import { Buffer } from "node:buffer";

const BASE64URL_32_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function decodeCanonicalBase64Url32(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !BASE64URL_32_PATTERN.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value
    ? decoded
    : undefined;
}
