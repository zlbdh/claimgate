import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { fail } from "./submission-validation-shared.mjs";

function publicIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 192 && b === 88 && octets[2] === 99) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  const documentation = (a === 192 && b === 0 && octets[2] === 2)
    || (a === 198 && b === 51 && octets[2] === 100)
    || (a === 203 && b === 0 && octets[2] === 113);
  return !documentation;
}

function publicIpv6(address) {
  const value = address.toLowerCase();
  if (value.includes("%") || value === "::" || value === "::1" || value.startsWith("::ffff:")) return false;
  const first = Number.parseInt(value.split(":", 1)[0], 16);
  if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff) return false;
  if (value.startsWith("2001:db8:") || value.startsWith("2001:0:") || value.startsWith("2002:")
    || value.startsWith("2001:2:") || /^2001:(?:1[0-9a-f]|2[0-9a-f]):/.test(value)
    || value.startsWith("3fff:")) return false;
  return true;
}

export function publicIpAddress(address, family) {
  if (typeof address !== "string" || (family !== 4 && family !== 6) || isIP(address) !== family) return false;
  return family === 4 ? publicIpv4(address) : publicIpv6(address);
}

export async function assertPublicDns(hostname, resolver = dnsLookup) {
  let results;
  try { results = await resolver(hostname, { all: true, verbatim: true }); }
  catch { fail("FINAL_DNS"); }
  if (!Array.isArray(results) || results.length < 1 || results.length > 32
    || results.some((entry) => !publicIpAddress(entry?.address, entry?.family))) fail("FINAL_DNS");
  return results;
}
