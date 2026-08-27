import { rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExternalFixture, PUBLIC_ENV, type ExternalFixture } from "./submission-validation-test-fixtures";
// @ts-expect-error The validator intentionally remains dependency-free JavaScript.
import { validateDevpostEvidence } from "./submission-validation-devpost.mjs";

const fixtures: ExternalFixture[] = [];
afterEach(async () => Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup())));

async function fixture() {
  const value = await createExternalFixture(); fixtures.push(value); return value;
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) { return (error as { code?: string }).code; }
  return undefined;
}

function validate(value: ExternalFixture) {
  return validateDevpostEvidence({
    root: value.root,
    evidencePath: value.evidencePath,
    urls: {
      live: PUBLIC_ENV.CLAIMGATE_PUBLIC_URL,
      repository: PUBLIC_ENV.CLAIMGATE_REPOSITORY_URL,
      video: PUBLIC_ENV.CLAIMGATE_VIDEO_URL,
    },
  });
}

async function replaceEvidence(value: ExternalFixture, patch: Record<string, unknown>) {
  await writeFile(value.evidencePath, JSON.stringify({ ...value.evidence, ...patch }));
}

describe("canonical Devpost draft evidence", () => {
  it("requires the new WebMCP, experience, before/after, and implementation fields", async () => {
    const value = await fixture();
    const { whyWebMcp: _removed, ...withoutWhy } = value.evidence;
    void _removed;
    await writeFile(value.evidencePath, JSON.stringify(withoutWhy));
    expect(await code(validate(value))).toBe("FINAL_DEVPOST");
  });

  it("rejects normalized copy that differs from canonical devpost.md", async () => {
    const value = await fixture();
    await replaceEvidence(value, { betterExperience: `${value.evidence.betterExperience} changed` });
    expect(await code(validate(value))).toBe("FINAL_DEVPOST");
  });

  it.each([
    ["pending", ["CLAIMGATE", "COPY", "PENDING"].join("_")],
    ["TODO", "TODO confirm later"],
    ["private path", ["D:", "workspace", "private", "proof.txt"].join("/")],
    ["IP", `connect to ${["10", "8", "0", "1"].join(".")}`],
    ["SSH", ["ssh", ["deployer", "@", "prod", ".", "example", ".", "org"].join("")].join(" ")],
    ["secret", `password="${["A7!", "qP9$", "x"].join("")}"`],
  ])("rejects %s in a public Devpost string", async (_label, unsafe) => {
    const value = await fixture();
    await replaceEvidence(value, { betterExperience: unsafe });
    expect(await code(validate(value))).toBe("FINAL_DEVPOST");
  });

  it("accepts the exact normalized canonical fields and user-attestation list", async () => {
    const value = await fixture();
    await expect(validate(value)).resolves.toMatchObject({ devpostChecks: 1, screenshots: 2 });
  });
});

describe("thumbnail and screenshot filesystem evidence", () => {
  it("requires a valid gallery thumbnail", async () => {
    const value = await fixture();
    await rm(value.galleryThumbnail);
    expect(await code(validate(value))).toBe("FINAL_SCREENSHOT");
  });

  it("rejects an image stored inside the repository", async () => {
    const value = await fixture();
    const inside = path.join(value.root, "thumbnail.png");
    await writeFile(inside, Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1]));
    await replaceEvidence(value, { galleryThumbnail: inside });
    expect(await code(validate(value))).toBe("FINAL_SCREENSHOT");
  });

  it("rejects an image path traversing a directory junction", async () => {
    const value = await fixture();
    const links = path.join(value.base, "image-links");
    await symlink(value.evidenceDir, links, "junction");
    await replaceEvidence(value, { galleryThumbnail: path.join(links, "thumbnail.png") });
    expect(await code(validate(value))).toBe("FINAL_SCREENSHOT");
  });

  it("rejects duplicate screenshot realpaths", async () => {
    const value = await fixture();
    await replaceEvidence(value, { screenshots: [value.screenshots[0], value.screenshots[0]] });
    expect(await code(validate(value))).toBe("FINAL_SCREENSHOT");
  });
});
