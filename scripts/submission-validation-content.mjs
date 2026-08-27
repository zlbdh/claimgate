import { isIP } from "node:net";
import { fail } from "./submission-validation-shared.mjs";

const PATH_CANARIES = new Set([
  "C:/secret.db", "C:/private.db", "C:/Windows",
  "C:/Program Files/Git/bin/sh.exe", "C:/Program Files/Git/usr/bin/sh.exe",
]);
const SECRET_CANARIES = new Set([
  "closure-create-token", "closure-stage-token", "closure-only-create", "closure-only-stage",
  "new-closure-only-stage", "abcdefghijklmnopqrstuA", "abcdefghijklmnopqrstuB",
  "abcdefghijklmnopqrstuQ", "secret&targetRole=STAFF", "x&targetRole=STAFF",
  "%C3%28&targetRole=STAFF", "%ZZ&targetRole=STAFF", "x&csrfToken=y&targetRole=STAFF",
  "x&targetRole=STAFF&userId=attacker", "client-intent-placeholder-v1",
  "x&targetRole=STAFF&resumeClaimId=a&resumeClaimId=b",
  "x&targetRole=STAFF&resumeClaimId=a&returnTo=https%3A%2F%2Fevil.test",
  "y&targetRole=STAFF", "x&targetRole=CLAIMANT", "x&targetRole=STAFF&targetRole=CLAIMANT",
  "x&targetRole=STAFF&resumeClaimId=a&returnTo=https%3A%2F%2Fevil",
  "hidden-csrf", "csrf-issue", "csrf-reissue", "csrf-handoff", "csrf-test",
  "reusable-csrf", "update-csrf", "stage-a-new", "internal-token", "forbidden", "readonly",
  "TEST_MASTER_KEY", "masterKey", "REQUIRED_ENV",
  "/srv/claimgate/private", "/srv/claimgate/private.sqlite",
  "<independent-stable-base64-key>",
]);
const FILE_VALUE_CANARIES = new Set([
  "src/features/reports/report-schema.ts\0PUBLIC_TOKEN\0/^[a-z0-9",
]);

function entropy(value) {
  const counts = new Map();
  for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
}

function hasPrivatePath(text) {
  const paths = text.matchAll(
    /(["'])([A-Za-z]:[\\/][^"'<>]+)\1|\b([A-Za-z]:[\\/][^\s"'`<>]+)|(\\\\[A-Za-z0-9._-]{2,}[\\/][A-Za-z0-9$_. -]{2,})|(\/(?:Users|home|workspace|workspaces)\/[^\s"'`<>]+|\/mnt\/[A-Za-z]\/[^\s"'`<>]+)/gi,
  );
  for (const match of paths) {
    const candidate = match[2] ?? match[3] ?? match[4] ?? match[5];
    if (!PATH_CANARIES.has(candidate)) return true;
  }
  return /AppData[\\/]Local[\\/]Temp/i.test(text);
}

function syntheticIp(value) {
  const mappedDocumentation = [["", "", "ffff"].join(":"), ["192", "0", "2", ""].join(".")].join(":");
  return value === "0.0.0.0" || value === "255.255.255.255" || value.startsWith("127.")
    || value.startsWith("192.0.2.") || value.startsWith("198.51.100.")
    || value.startsWith("203.0.113.") || value === "::1" || /^2001:db8:/i.test(value)
    || /^::ffff:c000:/i.test(value) || value.toLowerCase().startsWith(mappedDocumentation);
}

function ipValues(text) {
  const found = new Set(text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []);
  const ipv6 = text.match(/(?<![A-Za-z0-9_:])(?:[A-Fa-f0-9]{0,4}:){2,}[A-Fa-f0-9:.]+(?![A-Za-z0-9_:])/g) ?? [];
  for (const token of ipv6) {
    const value = token.replace(/^\[|\]$/g, "").replace(/[.,;]$/, "");
    if (isIP(value) === 6) found.add(value);
  }
  return [...found].filter((value) => isIP(value) !== 0);
}

function codeFile(file) {
  return typeof file === "string" && /\.(?:[cm]?[jt]sx?)$/i.test(file);
}

function semanticSecretName(name, delimiter, file) {
  const parts = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").split(/[_-]+/).map((part) => part.toLowerCase());
  if (parts.join("") === "idempotencykey") return false;
  const last = parts.at(-1);
  if (!["key", "secret", "token", "password"].includes(last)) return false;
  if (last !== "key") return true;
  if (parts.length === 1) return !(delimiter === ":" && codeFile(file));
  const keySemantics = new Set(["api", "access", "private", "signing", "hmac", "session", "csrf", "encryption"]);
  return parts[0] === "claimgate" || parts.slice(0, -1).some((part) => keySemantics.has(part));
}

function codeIdentifierReference(text, match, file) {
  const value = match[4];
  const safeMember = /^[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\?\.|\.)[A-Za-z_$][A-Za-z0-9_$]*)*!?$/;
  if (!codeFile(file) || !value || !safeMember.test(value)) return false;
  const start = text.lastIndexOf("\n", match.index ?? 0) + 1;
  const endIndex = text.indexOf("\n", match.index ?? 0);
  const line = text.slice(start, endIndex < 0 ? text.length : endIndex);
  const column = (match.index ?? 0) - start;
  const before = line.slice(0, column);
  const after = line.slice(column + match[0].length);
  const escapedName = match[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (match[2] === "=") {
    if (/(?:^|[(,])\s*$/.test(before) && /^\s*[,):]/.test(after)) return true;
    return new RegExp(`\\b(?:const|let|var)\\s+${escapedName}(?:\\s*:[^=]+)?\\s*=\\s*${escapedValue}(?=\\s*(?:[.;(,?=]))`)
      .test(line);
  }
  if (/^\s*[(.,;})?=]/.test(after)) return true;
  return new RegExp(`\\b${escapedName}\\s*:\\s*${escapedValue}(?=\\s*(?:[(.,;})?=]|as\\s+[A-Za-z_$]))`).test(line);
}

export function secretAssignmentFindings(text, options = {}) {
  const findings = [];
  const assignments = text.matchAll(
    /\b([A-Za-z][A-Za-z0-9_-]{0,80})[ \t]*([:=])[ \t]*(?:["']([^"'\r\n]{4,256})["']|([^\s"'`,;(){}\]]{4,256}))/g,
  );
  for (const match of assignments) {
    const [, name, delimiter] = match;
    if (!semanticSecretName(name, delimiter, options.file)) continue;
    const value = match[3] ?? match[4];
    if (SECRET_CANARIES.has(value) || ["CANARY", "PLACEHOLDER", "EXAMPLE"].includes(value)) continue;
    if (FILE_VALUE_CANARIES.has(`${options.file}\0${name}\0${value}`)) continue;
    if (codeIdentifierReference(text, match, options.file)) continue;
    if (value.length >= 8 && entropy(value) >= 2.75) findings.push({ name, value });
  }
  return findings;
}

function hasSecret(text, options) {
  if (/-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(text)) return true;
  if (/\b(?:ghp_|github_pat_|xox[baprs]-|sk-(?:proj-)?|AKIA)[A-Za-z0-9_-]{12,}\b/.test(text)) return true;
  return secretAssignmentFindings(text, options).length > 0;
}

function hasSshEndpoint(text) {
  for (const line of text.split(/\r?\n/)) {
    if (!/\b(?:ssh|scp|sftp)\b/.test(line) || /\$(?:\{|[A-Za-z_])|REPLACE_WITH_|<[^>]+>/.test(line)) continue;
    if (/\b[A-Za-z_][A-Za-z0-9_-]*@[A-Za-z0-9](?:[A-Za-z0-9.-]*\.)[A-Za-z]{2,}\b/.test(line)) return true;
  }
  return false;
}

export function scanPublicationText(text, options = {}) {
  const code = options.code;
  if (hasPrivatePath(text)) fail(code ?? "LOCAL_PRIVATE_PATH");
  if (hasSshEndpoint(text)) fail(code ?? "LOCAL_SSH_ENDPOINT");
  const ips = ipValues(text);
  if (ips.some((value) => options.strictIps || !syntheticIp(value))) fail(code ?? "LOCAL_REAL_IP");
  if (hasSecret(text, options)) fail(code ?? "LOCAL_SECRET");
  if (options.placeholders && /\b(?:TODO|TBD|FIXME)\b|\b[A-Z][A-Z0-9_]*_PENDING\b/.test(text)) {
    fail(code ?? "LOCAL_PLACEHOLDER");
  }
}
