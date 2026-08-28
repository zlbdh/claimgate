import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createExternalFixture, externalFetch, playerHtml, publicLookup, PUBLIC_ENV, type ExternalFixture,
} from "./submission-validation-test-fixtures";
// @ts-expect-error The validator intentionally remains dependency-free JavaScript.
import { validateExternalSubmission } from "./submission-validation-external.mjs";

const fixtures: ExternalFixture[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.cleanup()));
});

async function fixture(): Promise<ExternalFixture> {
  const value = await createExternalFixture(); fixtures.push(value); return value;
}

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) { return (error as { code?: string }).code; }
  return undefined;
}

function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function crlf(text: string): string {
  return lf(text).replace(/\n/g, "\r\n");
}

describe("live and GitHub final gates", () => {
  it("requires all four final environment values", async () => {
    const value = await fixture();
    const env = { ...value.env, CLAIMGATE_VIDEO_URL: undefined };
    expect(await code(validateExternalSubmission({ root: value.root, env, fetch: externalFetch(value), lookup: publicLookup })))
      .toBe("FINAL_ENV");
  });

  it("rejects credential-bearing or non-origin public URLs before fetching", async () => {
    const value = await fixture();
    const env = { ...value.env, CLAIMGATE_PUBLIC_URL: "https://user:password@demo.claimgate.example" };
    const fetcher = vi.fn(externalFetch(value));
    expect(await code(validateExternalSubmission({ root: value.root, env, fetch: fetcher, lookup: publicLookup })))
      .toBe("FINAL_URL");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    "https://localhost:8443", "https://[::1]:8443", "https://demo.claimgate.example",
  ])("rejects a non-public origin: %s", async (publicUrl) => {
    const value = await fixture();
    const env = { ...value.env, CLAIMGATE_PUBLIC_URL: publicUrl };
    expect(await code(validateExternalSubmission({ root: value.root, env, fetch: vi.fn(), lookup: publicLookup })))
      .toBe("FINAL_URL");
  });

  it.each([
    ["CLAIMGATE_PUBLIC_URL", "https://demo.claimgate.dev:443"],
    ["CLAIMGATE_REPOSITORY_URL", "https://github.com:443/claim-gate/claimgate"],
    ["CLAIMGATE_VIDEO_URL", "https://www.youtube.com:443/watch?v=abcdefghijk"],
    ["CLAIMGATE_PUBLIC_URL", "https://demo.claimgate.dev:0443"],
    ["CLAIMGATE_REPOSITORY_URL", "https://github.com:0443/claim-gate/claimgate"],
    ["CLAIMGATE_VIDEO_URL", "https://www.youtube.com:0443/watch?v=abcdefghijk"],
  ])("rejects an explicit default HTTPS port in %s", async (name, url) => {
    const value = await fixture();
    const env = { ...value.env, [name]: url };
    expect(await code(validateExternalSubmission({ root: value.root, env, fetch: vi.fn(), lookup: publicLookup })))
      .toBe("FINAL_URL");
  });

  it.each([
    ["lookup failure", async () => { throw new Error("dns detail"); }],
    ["private A", async () => [{ address: ["10", "8", "0", "1"].join("."), family: 4 }]],
    ["mixed public/private", async () => [
      { address: ["93", "184", "216", "34"].join("."), family: 4 },
      { address: ["192", "168", "1", "8"].join("."), family: 4 },
    ]],
    ["mapped private AAAA", async () => [{ address: `::ffff:${["10", "8", "0", "1"].join(".")}`, family: 6 }]],
    ["documentation AAAA", async () => [{ address: "2001:db8::1", family: 6 }]],
    ["reserved relay A", async () => [{ address: ["192", "88", "99", "1"].join("."), family: 4 }]],
    ["6to4 mapped private", async () => [{
      address: ["2002", "c0a8", "0101", "", "1"].join(":"), family: 6,
    }]],
  ])("rejects %s DNS results before fetch", async (_label, lookup) => {
    const value = await fixture();
    const fetcher = vi.fn();
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: fetcher, lookup })))
      .toBe("FINAL_DNS");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ["redirect", new Response(null, { status: 302, headers: { Location: "https://other.example" } })],
    ["bad contract", new Response('{"status":"healthy","detail":"extra"}', {
      status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    })],
    ["oversized", new Response("x".repeat(900), {
      status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    })],
  ])("rejects a %s live health response", async (_label, health) => {
    const value = await fixture();
    const fetcher = vi.fn(externalFetch(value, {
      [`${PUBLIC_ENV.CLAIMGATE_PUBLIC_URL}/api/health`]: health,
    }));
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: fetcher, lookup: publicLookup })))
      .toBe("FINAL_LIVE");
    expect(fetcher).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ redirect: "error" }));
  });

  it.each([
    ["private repository", { private: true, visibility: "private", default_branch: "main", license: { spdx_id: "MIT" } }],
    ["wrong default branch", { private: false, visibility: "public", default_branch: "master", license: { spdx_id: "MIT" } }],
    ["missing MIT license", { private: false, visibility: "public", default_branch: "main", license: null }],
  ])("rejects a GitHub repository with %s", async (_label, repository) => {
    const value = await fixture();
    const fetcher = externalFetch(value, {
      "https://api.github.com/repos/claim-gate/claimgate": Response.json(repository),
    });
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: fetcher, lookup: publicLookup })))
      .toBe("FINAL_REPOSITORY");
  });

  it("rejects anonymous raw files that do not match the reviewed local files", async () => {
    const value = await fixture();
    const fetcher = externalFetch(value, {
      "https://raw.githubusercontent.com/claim-gate/claimgate/main/README.md": new Response("different"),
    });
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: fetcher, lookup: publicLookup })))
      .toBe("FINAL_REPOSITORY_CONTENT");
  });

  it("accepts semantically identical README and LICENSE when only CRLF versus LF differs", async () => {
    const value = await fixture();
    await writeFile(`${value.root}/README.md`, crlf(value.readme));
    await writeFile(`${value.root}/LICENSE`, crlf(value.license));
    const fetcher = externalFetch(value, {
      "https://raw.githubusercontent.com/claim-gate/claimgate/main/README.md": new Response(lf(value.readme)),
      "https://raw.githubusercontent.com/claim-gate/claimgate/main/LICENSE": new Response(lf(value.license)),
    });
    await expect(validateExternalSubmission({ root: value.root, env: value.env, fetch: fetcher, lookup: publicLookup }))
      .resolves.toEqual(expect.objectContaining({ externalChecks: 4 }));
  });

  it("still rejects a text difference such as an extra trailing line", async () => {
    const value = await fixture();
    await writeFile(`${value.root}/README.md`, crlf(value.readme));
    const fetcher = externalFetch(value, {
      "https://raw.githubusercontent.com/claim-gate/claimgate/main/README.md": new Response(`${lf(value.readme)}\nextra line\n`),
    });
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: fetcher, lookup: publicLookup })))
      .toBe("FINAL_REPOSITORY_CONTENT");
  });

  it("rejects an orphan carriage return even when local and remote bytes match", async () => {
    const value = await fixture();
    const invalidText = Buffer.from("line 1\rline 2\n", "utf8");
    await writeFile(`${value.root}/README.md`, invalidText);
    const fetcher = externalFetch(value, {
      "https://raw.githubusercontent.com/claim-gate/claimgate/main/README.md": new Response(invalidText),
    });
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: fetcher, lookup: publicLookup })))
      .toBe("FINAL_REPOSITORY_CONTENT");
  });

  it("rejects invalid UTF-8 even when local and remote bytes match", async () => {
    const value = await fixture();
    const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x41]);
    await writeFile(`${value.root}/README.md`, invalidUtf8);
    const fetcher = externalFetch(value, {
      "https://raw.githubusercontent.com/claim-gate/claimgate/main/README.md": new Response(invalidUtf8),
    });
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: fetcher, lookup: publicLookup })))
      .toBe("FINAL_REPOSITORY_CONTENT");
  });
});

describe("YouTube and Devpost final gates", () => {
  it.each([
    ["unlisted", { microformat: { playerMicroformatRenderer: { isUnlisted: true } } }],
    ["too long", { videoDetails: { lengthSeconds: "180", isLiveContent: false } }],
    ["no audio", { streamingData: { adaptiveFormats: [{ mimeType: "video/mp4", width: 1920 }] } }],
    ["wrong video id", { videoDetails: { videoId: "zzzzzzzzzzz", lengthSeconds: "162", isLiveContent: false } }],
  ])("rejects a YouTube video that is %s", async (_label, playerOverride) => {
    const value = await fixture();
    const fetcher = externalFetch(value, {
      [PUBLIC_ENV.CLAIMGATE_VIDEO_URL]: new Response(playerHtml(playerOverride)),
    });
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: fetcher, lookup: publicLookup })))
      .toBe("FINAL_VIDEO");
  });

  it("rejects invalid Devpost JSON", async () => {
    const value = await fixture();
    await import("node:fs/promises").then(({ writeFile }) => writeFile(value.evidencePath, "{"));
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: externalFetch(value), lookup: publicLookup })))
      .toBe("FINAL_DEVPOST");
  });

  it("rejects a Devpost URL mismatch or a submitted claim", async () => {
    const value = await fixture();
    const changed = { ...value.evidence, repositoryUrl: "https://github.com/other/repo", submitted: true };
    await import("node:fs/promises").then(({ writeFile }) => writeFile(value.evidencePath, JSON.stringify(changed)));
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: externalFetch(value), lookup: publicLookup })))
      .toBe("FINAL_DEVPOST");
  });

  it("rejects a private absolute path in public Devpost copy", async () => {
    const value = await fixture();
    const privatePath = ["C:", "Users", "person", "private-note.txt"].join("\\");
    const changed = { ...value.evidence, testingInstructions: `Read ${privatePath} before judging.` };
    await import("node:fs/promises").then(({ writeFile }) => writeFile(value.evidencePath, JSON.stringify(changed)));
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: externalFetch(value), lookup: publicLookup })))
      .toBe("FINAL_DEVPOST");
  });

  it("rejects a missing or non-image screenshot", async () => {
    const value = await fixture();
    await import("node:fs/promises").then(({ writeFile }) => writeFile(value.screenshots[0]!, "not an image"));
    expect(await code(validateExternalSubmission({ root: value.root, env: value.env, fetch: externalFetch(value), lookup: publicLookup })))
      .toBe("FINAL_SCREENSHOT");
  });

  it("accepts a fully public draft package", async () => {
    const value = await fixture();
    const fetcher = vi.fn(externalFetch(value));
    await expect(validateExternalSubmission({ root: value.root, env: value.env, fetch: fetcher, lookup: publicLookup }))
      .resolves.toEqual(expect.objectContaining({ externalChecks: 4 }));
    expect(fetcher).toHaveBeenCalledTimes(6);
    for (const call of fetcher.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ redirect: "error", cache: "no-store" }));
      expect((call[1] as RequestInit).headers).not.toHaveProperty("Authorization");
    }
  });
});
