import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(path), "utf8");
}

function requireText(value: string, pattern: string | RegExp, label: string): void {
  const found = typeof pattern === "string" ? value.includes(pattern) : pattern.test(value);
  if (!found) throw new Error(`pickup client check missing ${label}`);
}

function forbid(value: string, pattern: RegExp, label: string): void {
  if (pattern.test(value)) throw new Error(`pickup client check found ${label}`);
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = resolve(root, entry);
    if (statSync(path).isDirectory()) result.push(...files(path));
    else result.push(path);
  }
  return result;
}

const panel = source("src/components/pickup-pass-panel.tsx");
const handoff = source("src/components/staff-handoff-form.tsx");
const claimantPage = source("src/app/claimant/claims/[claimId]/page.tsx");
const staffPage = source("src/app/staff/claims/[claimId]/page.tsx");
const registry = source("src/features/webmcp/tool-registry.ts");

for (const [pattern, label] of [
  ['"use client"', "Client Component boundary"],
  ["QRCode.toCanvas", "canvas QR renderer"],
  ["clearRect", "canvas pixel cleanup"],
  ["canvas.width = 0", "canvas width cleanup"],
  ["canvas.height = 0", "canvas height cleanup"],
  ["pagehide", "pagehide cleanup"],
  ["pageshow", "pageshow cleanup"],
  ["popstate", "history cleanup"],
  ["new AbortController", "request abort controller"],
  ["signal: controller.signal", "fetch abort signal"],
  ["epochRef", "request generation gate"],
  ['document.createElement("canvas")', "detached QR canvas"],
  ["drawImage(detached", "generation-gated canvas commit"],
  ["parsePickupIssuanceClientResponse", "strict issuance response parser"],
] as const) requireText(panel, pattern, label);
forbid(panel, /toDataURL|data:image|localStorage|sessionStorage|history\.(?:push|replace)State|console\.|analytics/i,
  "credential persistence, URL data, logging, or analytics");
forbid(panel, /data-(?:token|credential)|title=\{?credential|alt=\{?credential|key=\{?credential/i,
  "credential-bearing DOM metadata");

for (const [pattern, label] of [
  ['type="password"', "Staff password field"],
  ['autoComplete="off"', "autocomplete off"],
  ["spellCheck={false}", "spellcheck off"],
  ["pagehide", "Staff pagehide cleanup"],
  ["pageshow", "Staff pageshow cleanup"],
  ["finally", "Staff finally cleanup"],
  ["parseHandoffClientResponse", "strict handoff response parser"],
] as const) requireText(handoff, pattern, label);
if (handoff.indexOf("clearPassword(inputRef.current)") > handoff.indexOf("await (props.fetcher")) {
  throw new Error("pickup client check did not clear Staff password before transport");
}
forbid(handoff, /localStorage|sessionStorage|history\.|console\.|analytics/i, "Staff credential persistence");

for (const page of [claimantPage, staffPage]) {
  forbid(page, /pickup_pass_|transientToken|\bdigest\b|\bsalt\b/i, "server page secret field");
  forbid(page, /token=\{[^}]*(?:pickup|credential)/i, "server token prop");
}
requireText(registry, /scope\.page === "CLAIM"[\s\S]*return \[\]/, "empty Claim WebMCP set");

const clientChunks = files(resolve(".next/static/chunks"))
  .filter((path) => path.endsWith(".js"))
  .map((path) => readFileSync(path, "utf8"))
  .join("\n");
forbid(clientChunks, /ClaimGate\/pickup-pass\/v1|pickup_pass_digest|runPickupIssuanceIdempotent/,
  "server pickup verifier in client build");
