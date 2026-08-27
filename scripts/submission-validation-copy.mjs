import { decodeUtf8, fail } from "./submission-validation-shared.mjs";

export const REQUIRED_SUBMISSION_FILES = Object.freeze([
  "README.md",
  "LICENSE",
  "docs/submission/architecture.md",
  "docs/submission/demo-script.md",
  "docs/submission/devpost.md",
  "docs/submission/deployment.md",
  "docs/submission/testing.md",
  "docs/submission/webmcp-probe.md",
]);

const TOOL_NAMES = Object.freeze([
  "create_lost_report_draft", "update_lost_report_draft", "list_my_reports",
  "find_candidate_matches", "stage_claim_candidate", "get_claim_status",
  "get_pickup_instructions", "list_pending_claims", "get_claim_review_summary",
]);
const pending = (...parts) => parts.join("_");
const PENDING_LOCATIONS = Object.freeze(Object.fromEntries([
  [pending("CLAIMGATE", "PUBLIC", "URL", "PENDING"), ["README.md", "docs/submission/devpost.md"]],
  [pending("CLAIMGATE", "PUBLIC", "REPOSITORY", "PENDING"), ["README.md", "docs/submission/devpost.md"]],
  [pending("CLAIMGATE", "PUBLIC", "VIDEO", "PENDING"), ["README.md", "docs/submission/devpost.md"]],
  [pending("CLAIMGATE", "GALLERY", "THUMBNAIL", "PENDING"), ["docs/submission/devpost.md"]],
  [pending("CLAIMGATE", "SCREENSHOTS", "PENDING"), ["docs/submission/devpost.md"]],
]));
const OPERATIONAL_PLACEHOLDERS = new Set([
  "REPLACE_WITH_DEPLOYMENT_HOST", "REPLACE_WITH_DEPLOYMENT_PORT",
  "REPLACE_WITH_DEPLOYMENT_USER", "REPLACE_WITH_RELEASE_ID",
  "REPLACE_WITH_DEDICATED_CERTIFICATE_NAME",
]);

function requireAll(text, values, code) {
  if (values.some((value) => !text.includes(value))) fail(code);
}

function requireHeading(text, heading, code) {
  if (!new RegExp(`^## ${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "mi").test(text)) fail(code);
}

export function submissionSection(text, heading) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start < 0) return "";
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  return lines.slice(start + 1, end).join("\n").trim();
}

function validateReadme(text) {
  for (const heading of [
    "The problem", "Why WebMCP fits", "Matching and privacy boundaries", "Run locally",
    "Test and verify", "License",
  ]) requireHeading(text, heading, "LOCAL_README_CONTRACT");
  requireAll(text, TOOL_NAMES, "LOCAL_README_CONTRACT");
  requireAll(text, ["lost-property", "property desk", "human-only", "threat model", "MIT License"], "LOCAL_README_CONTRACT");
  requireAll(text, ["DNS rebinding", "public-artifact check"], "LOCAL_README_CONTRACT");
  if (!/document\.modelContext\.registerTool\(\)/.test(text) || !/npm run verify/.test(text)
    || !/npm run test:e2e/.test(text)) fail("LOCAL_README_CONTRACT");
}

function validateLicense(text) {
  requireAll(text, [
    "MIT License", "Permission is hereby granted, free of charge", "THE SOFTWARE IS PROVIDED \"AS IS\"",
  ], "LOCAL_LICENSE_CONTRACT");
}

function validateArchitecture(text) {
  requireAll(text, ["```mermaid", "document.modelContext", ...TOOL_NAMES], "LOCAL_ARCHITECTURE_CONTRACT");
  requireAll(text, ["Human-only actions", "Threat model", "Native WebMCP lifecycle"], "LOCAL_ARCHITECTURE_CONTRACT");
}

function validateDemo(text) {
  const durations = [...text.matchAll(/(\d+) minutes?\s*(\d+) seconds?/gi)]
    .map((match) => Number(match[1]) * 60 + Number(match[2]));
  if (durations.length < 2 || Math.max(...durations) >= 180) fail("LOCAL_DEMO_CONTRACT");
  requireAll(text, [
    "actual ChatGPT in-app browser", "in-app browser discovers native WebMCP tools", "Agent activity",
    "**Start public demo**", "**Publish report manually**", "**Submit private evidence**",
    "**Approve claim**", "**Generate pickup pass**", "**Copy credential**",
    "**Switch to Staff role**", "**Open Staff review desk**", "**Switch to Claimant role**",
    "**Confirm atomic handoff**", "COLLECTED", "visible no-tools status",
  ], "LOCAL_DEMO_CONTRACT");
}

function validateDevpost(text) {
  const fields = [
    ["Project name", 4], ["Tagline", 20], ["Links", 20], ["Built with", 20],
    ["Problem", 40], ["Why WebMCP", 40], ["Better experience", 40], ["Before and after", 40],
    ["What it does", 40], ["How implemented", 40],
    ["Challenges we ran into", 40], ["Accomplishments that we're proud of", 40],
    ["What we learned", 40], ["What's next", 40], ["Testing instructions", 40],
    ["Form-only user confirmation checklist", 80],
  ];
  for (const [heading, minimum] of fields) {
    requireHeading(text, heading, "LOCAL_DEVPOST_CONTRACT");
    const body = submissionSection(text, heading);
    if (body.length < minimum || !/[A-Za-z]{3}/.test(body)) fail("LOCAL_DEVPOST_CONTRACT");
  }
}

function validatePlaceholders(mode, documents, publicTexts) {
  const approved = new Set(Object.keys(PENDING_LOCATIONS));
  for (const [file, text] of publicTexts) {
    const tokens = text.match(/\b[A-Z][A-Z0-9_]*_PENDING\b/g) ?? [];
    for (const token of tokens) {
      if (mode === "final" || !approved.has(token)
        || !PENDING_LOCATIONS[token].includes(file)) fail("LOCAL_PLACEHOLDER");
    }
  }
  if (mode === "prepublish") {
    for (const [token, locations] of Object.entries(PENDING_LOCATIONS)) {
      if (locations.some((file) => !documents.get(file)?.includes(token))) fail("LOCAL_PLACEHOLDER");
    }
  }
  for (const file of REQUIRED_SUBMISSION_FILES) {
    const text = documents.get(file) ?? "";
    if (/\b(?:TODO|TBD|FIXME)\b/.test(text)) fail("LOCAL_PLACEHOLDER");
    for (const token of text.match(/\bREPLACE_WITH_[A-Z0-9_]+\b/g) ?? []) {
      if (file !== "docs/submission/deployment.md" || !OPERATIONAL_PLACEHOLDERS.has(token)) {
        fail("LOCAL_PLACEHOLDER");
      }
    }
  }
}

export function validateSubmissionCopy(mode, requiredBytes, publicTexts) {
  const documents = new Map();
  for (const file of REQUIRED_SUBMISSION_FILES) {
    const bytes = requiredBytes.get(file);
    if (!bytes || bytes.byteLength < 40 || bytes.byteLength > 512 * 1024) fail("LOCAL_REQUIRED_FILE");
    documents.set(file, decodeUtf8(bytes, "LOCAL_REQUIRED_FILE"));
  }
  validateReadme(documents.get("README.md"));
  validateLicense(documents.get("LICENSE"));
  validateArchitecture(documents.get("docs/submission/architecture.md"));
  validateDemo(documents.get("docs/submission/demo-script.md"));
  validateDevpost(documents.get("docs/submission/devpost.md"));
  validatePlaceholders(mode, documents, publicTexts);
}
