import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { submissionSection } from "./submission-validation-copy.mjs";
import { scanPublicationText } from "./submission-validation-content.mjs";
import { hasImageMagic, imageExtension, MAX_IMAGE_BYTES } from "./submission-validation-image.mjs";
import { decodeUtf8, fail, isInside, parseJson, readFileBounded } from "./submission-validation-shared.mjs";

const EVIDENCE_LIMIT = 256 * 1024;
const COPY_LIMIT = 512 * 1024;
const FIELD_HEADINGS = Object.freeze({
  projectName: "Project name", tagline: "Tagline", problem: "Problem",
  whyWebMcp: "Why WebMCP", betterExperience: "Better experience", beforeAndAfter: "Before and after",
  whatItDoes: "What it does", howImplemented: "How implemented",
  challenges: "Challenges we ran into", accomplishments: "Accomplishments that we're proud of",
  whatWeLearned: "What we learned", whatsNext: "What's next", testingInstructions: "Testing instructions",
});
const EXACT_KEYS = new Set([
  ...Object.keys(FIELD_HEADINGS), "builtWith", "tryItOutUrl", "repositoryUrl", "videoUrl",
  "galleryThumbnail", "screenshots", "draftSaved", "submitted",
]);

function normalize(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : undefined;
}

function canonicalCopy(markdown) {
  const fields = Object.fromEntries(Object.entries(FIELD_HEADINGS).map(([field, heading]) => (
    [field, normalize(submissionSection(markdown, heading))]
  )));
  const builtWith = normalize(submissionSection(markdown, "Built with"))
    ?.split(",").map((value) => value.trim()).filter(Boolean);
  if (Object.values(fields).some((value) => !value) || !builtWith || builtWith.length < 3) fail("FINAL_DEVPOST");
  return { fields, builtWith };
}

function validateEvidenceSchema(value, urls, canonical) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("FINAL_DEVPOST");
  const keys = Object.keys(value);
  if (keys.length !== EXACT_KEYS.size || keys.some((key) => !EXACT_KEYS.has(key))) fail("FINAL_DEVPOST");
  for (const [field, expected] of Object.entries(canonical.fields)) {
    if (normalize(value[field]) !== expected) fail("FINAL_DEVPOST");
    scanPublicationText(value[field], { code: "FINAL_DEVPOST", strictIps: true, placeholders: true });
  }
  if (!Array.isArray(value.builtWith)
    || JSON.stringify(value.builtWith.map(normalize)) !== JSON.stringify(canonical.builtWith)) fail("FINAL_DEVPOST");
  for (const entry of value.builtWith) scanPublicationText(entry, {
    code: "FINAL_DEVPOST", strictIps: true, placeholders: true,
  });
  if (value.tryItOutUrl !== urls.live || value.repositoryUrl !== urls.repository
    || value.videoUrl !== urls.video || value.draftSaved !== true || value.submitted !== false
    || typeof value.galleryThumbnail !== "string" || !Array.isArray(value.screenshots)
    || value.screenshots.length < 2 || value.screenshots.length > 10) fail("FINAL_DEVPOST");
}

async function secureExternalFile(candidate, root, code) {
  if (typeof candidate !== "string" || !path.isAbsolute(candidate) || candidate.length > 4_096) fail(code);
  let metadata; let target;
  try { metadata = await lstat(candidate); target = await realpath(candidate); }
  catch { fail(code); }
  if (metadata.isSymbolicLink() || !metadata.isFile() || isInside(root, target)
    || path.normalize(path.resolve(candidate)) !== path.normalize(target)) fail(code);
  return { metadata, target };
}

async function validateImage(candidate, root) {
  const { metadata, target } = await secureExternalFile(candidate, root, "FINAL_SCREENSHOT");
  const extension = imageExtension(target);
  if (!extension || metadata.size < 8 || metadata.size > MAX_IMAGE_BYTES) fail("FINAL_SCREENSHOT");
  const bytes = await readFileBounded(target, MAX_IMAGE_BYTES, "FINAL_SCREENSHOT");
  if (!hasImageMagic(bytes, extension)) fail("FINAL_SCREENSHOT");
  return target;
}

export async function validateDevpostEvidence(options) {
  let root;
  try { root = await realpath(options.root); } catch { fail("FINAL_DEVPOST"); }
  const evidenceFile = await secureExternalFile(options.evidencePath, root, "FINAL_DEVPOST");
  if (path.extname(evidenceFile.target).toLowerCase() !== ".json"
    || evidenceFile.metadata.size > EVIDENCE_LIMIT) fail("FINAL_DEVPOST");
  const evidence = parseJson(
    await readFileBounded(evidenceFile.target, EVIDENCE_LIMIT, "FINAL_DEVPOST"), "FINAL_DEVPOST",
  );
  const markdown = decodeUtf8(
    await readFileBounded(path.join(root, "docs/submission/devpost.md"), COPY_LIMIT, "FINAL_DEVPOST"),
    "FINAL_DEVPOST",
  );
  const canonical = canonicalCopy(markdown);
  validateEvidenceSchema(evidence, options.urls, canonical);
  const thumbnail = await validateImage(evidence.galleryThumbnail, root);
  const screenshots = [];
  for (const candidate of evidence.screenshots) screenshots.push(await validateImage(candidate, root));
  if (new Set(screenshots).size !== screenshots.length) fail("FINAL_SCREENSHOT");
  return Object.freeze({ devpostChecks: 1, screenshots: screenshots.length, thumbnail: Boolean(thumbnail) });
}
