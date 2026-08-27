import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const PUBLIC_ENV = Object.freeze({
  CLAIMGATE_PUBLIC_URL: "https://demo.claimgate.dev",
  CLAIMGATE_REPOSITORY_URL: "https://github.com/claim-gate/claimgate",
  CLAIMGATE_VIDEO_URL: "https://www.youtube.com/watch?v=abcdefghijk",
});

export const REQUIRED_LOCAL_FILES = [
  "README.md",
  "LICENSE",
  "docs/submission/architecture.md",
  "docs/submission/demo-script.md",
  "docs/submission/devpost.md",
  "docs/submission/deployment.md",
  "docs/submission/testing.md",
  "docs/submission/webmcp-probe.md",
] as const;

export const publicLookup = async () => [
  { address: ["93", "184", "216", "34"].join("."), family: 4 },
  { address: ["2606", "4700", "4700", "", "1111"].join(":"), family: 6 },
];

export async function localCandidateFiles(): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const relative of REQUIRED_LOCAL_FILES) {
    files.set(relative, await readFile(path.join(process.cwd(), relative)));
  }
  files.set("src/public-example.ts", Buffer.from("export const safe = true;\n"));
  return files;
}

export function localIo(files: Map<string, Buffer>) {
  return {
    async listPublicFiles() { return [...files.keys()]; },
    async inspectPublicFile(relative: string) {
      const value = files.get(relative);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return { size: value.byteLength, isFile: true, isSymbolicLink: false, realPath: `/virtual/${relative}` };
    },
    async readPublicFile(relative: string) {
      const value = files.get(relative);
      if (value === undefined) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      return value;
    },
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function normalizedSection(markdown: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start < 0) throw new Error("missing fixture heading");
  const bodyStart = markdown.indexOf("\n", start) + 1;
  const next = markdown.indexOf("\n## ", bodyStart);
  return markdown.slice(bodyStart, next < 0 ? markdown.length : next).replace(/\s+/g, " ").trim();
}

export type ExternalFixture = Awaited<ReturnType<typeof createExternalFixture>>;

export async function createExternalFixture() {
  const base = await mkdtemp(path.join(tmpdir(), "claimgate-submission-"));
  const root = path.join(base, "repo");
  const evidenceDir = path.join(base, "evidence");
  await mkdir(root);
  await mkdir(evidenceDir);
  const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");
  const license = await readFile(path.join(process.cwd(), "LICENSE"), "utf8");
  const devpost = await readFile(path.join(process.cwd(), "docs/submission/devpost.md"), "utf8");
  await mkdir(path.join(root, "docs/submission"), { recursive: true });
  await writeFile(path.join(root, "README.md"), readme);
  await writeFile(path.join(root, "LICENSE"), license);
  await writeFile(path.join(root, "docs/submission/devpost.md"), devpost);
  const screenshots = [path.join(evidenceDir, "flow.png"), path.join(evidenceDir, "tools.jpg")];
  const galleryThumbnail = path.join(evidenceDir, "thumbnail.png");
  await writeFile(screenshots[0]!, PNG);
  await writeFile(screenshots[1]!, JPEG);
  await writeFile(galleryThumbnail, PNG);
  const evidencePath = path.join(evidenceDir, "devpost-evidence.json");
  const evidence = {
    projectName: normalizedSection(devpost, "Project name"),
    tagline: normalizedSection(devpost, "Tagline"),
    builtWith: normalizedSection(devpost, "Built with").split(",").map((value) => value.trim()),
    problem: normalizedSection(devpost, "Problem"),
    whyWebMcp: normalizedSection(devpost, "Why WebMCP"),
    betterExperience: normalizedSection(devpost, "Better experience"),
    beforeAndAfter: normalizedSection(devpost, "Before and after"),
    whatItDoes: normalizedSection(devpost, "What it does"),
    howImplemented: normalizedSection(devpost, "How implemented"),
    challenges: normalizedSection(devpost, "Challenges we ran into"),
    accomplishments: normalizedSection(devpost, "Accomplishments that we're proud of"),
    whatWeLearned: normalizedSection(devpost, "What we learned"),
    whatsNext: normalizedSection(devpost, "What's next"),
    testingInstructions: normalizedSection(devpost, "Testing instructions"),
    tryItOutUrl: PUBLIC_ENV.CLAIMGATE_PUBLIC_URL,
    repositoryUrl: PUBLIC_ENV.CLAIMGATE_REPOSITORY_URL,
    videoUrl: PUBLIC_ENV.CLAIMGATE_VIDEO_URL,
    galleryThumbnail,
    screenshots,
    draftSaved: true,
    submitted: false,
  };
  await writeFile(evidencePath, JSON.stringify(evidence));
  return {
    base, root, evidenceDir, evidencePath, screenshots, galleryThumbnail, evidence, readme, license, devpost,
    env: { ...PUBLIC_ENV, CLAIMGATE_DEVPOST_EVIDENCE: evidencePath },
    async cleanup() { await rm(base, { recursive: true, force: true }); },
  };
}

export function playerHtml(overrides: Record<string, unknown> = {}): string {
  const response = {
    playabilityStatus: { status: "OK" },
    videoDetails: { videoId: "abcdefghijk", lengthSeconds: "162", isLiveContent: false },
    microformat: { playerMicroformatRenderer: { isUnlisted: false } },
    streamingData: {
      adaptiveFormats: [{ mimeType: "audio/webm; codecs=opus", audioQuality: "AUDIO_QUALITY_MEDIUM", audioChannels: 2 }],
    },
    ...overrides,
  };
  return `<script>var ytInitialPlayerResponse = ${JSON.stringify(response)};</script>`;
}

export function externalFetch(fixture: ExternalFixture, overrides: Record<string, Response> = {}) {
  const defaults: Record<string, Response> = {
    [`${PUBLIC_ENV.CLAIMGATE_PUBLIC_URL}/api/health`]: new Response('{"status":"healthy"}', {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    }),
    "https://api.github.com/repos/claim-gate/claimgate": Response.json({
      private: false, visibility: "public", default_branch: "main", license: { spdx_id: "MIT" },
    }),
    "https://raw.githubusercontent.com/claim-gate/claimgate/main/README.md": new Response(fixture.readme),
    "https://raw.githubusercontent.com/claim-gate/claimgate/main/LICENSE": new Response(fixture.license),
    [`https://www.youtube.com/oembed?url=${encodeURIComponent(PUBLIC_ENV.CLAIMGATE_VIDEO_URL)}&format=json`]: Response.json({
      type: "video", provider_name: "YouTube", title: "ClaimGate demo",
    }),
    [PUBLIC_ENV.CLAIMGATE_VIDEO_URL]: new Response(playerHtml()),
  };
  return async (input: RequestInfo | URL, _init?: RequestInit) => {
    void _init;
    const url = String(input);
    const response = overrides[url] ?? defaults[url];
    if (response === undefined) throw new Error("unexpected URL");
    return response.clone();
  };
}
