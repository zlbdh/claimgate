import { Buffer } from "node:buffer";

export function tamperCandidateHandleMac(handle: string): string {
  const parts = handle.split(".");
  if (parts.length !== 4 || !/^[A-Za-z0-9_-]{43}$/.test(parts[3] ?? "")) {
    throw new TypeError("Expected a structurally valid candidate handle");
  }
  const mac = Buffer.from(parts[3]!, "base64url");
  if (mac.length !== 32 || mac.toString("base64url") !== parts[3]) {
    throw new TypeError("Expected a canonical candidate MAC");
  }
  mac[0] = mac[0]! ^ 0x01;
  return `${parts.slice(0, 3).join(".")}.${mac.toString("base64url")}`;
}
