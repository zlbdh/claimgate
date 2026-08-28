import { describe, expect, it, vi } from "vitest";
import { localCandidateFiles, localIo } from "./submission-validation-test-fixtures";
// @ts-expect-error The validator intentionally remains dependency-free JavaScript.
import { validateLocalSubmission } from "./submission-validation-local.mjs";
// @ts-expect-error The CLI intentionally remains dependency-free JavaScript.
import { runSubmissionCli } from "./validate-submission.mjs";
// @ts-expect-error The validator intentionally remains dependency-free JavaScript.
import { submissionSection } from "./submission-validation-copy.mjs";

async function failureCode(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) { return (error as { code?: string }).code; }
  return undefined;
}

describe("local submission validation", () => {
  it("rejects a missing required public document", async () => {
    const files = await localCandidateFiles("prepublish");
    files.delete("docs/submission/architecture.md");

    expect(await failureCode(validateLocalSubmission({
      mode: "prepublish", root: process.cwd(), io: localIo(files),
    }))).toBe("LOCAL_REQUIRED_FILE");
  });

  it("rejects a README with a required section removed", async () => {
    const files = await localCandidateFiles("prepublish");
    const readme = files.get("README.md")!.toString("utf8")
      .replace("## Why WebMCP fits", "## Browser integration");
    files.set("README.md", Buffer.from(readme));

    expect(await failureCode(validateLocalSubmission({
      mode: "prepublish", root: process.cwd(), io: localIo(files),
    }))).toBe("LOCAL_README_CONTRACT");
  });

  it("rejects a demo script that no longer proves real tool discovery", async () => {
    const files = await localCandidateFiles("prepublish");
    const demoPath = "docs/submission/demo-script.md";
    files.set(demoPath, Buffer.from(files.get(demoPath)!.toString("utf8")
      .replace("in-app browser discovers native WebMCP tools", "browser uses assistance")));
    expect(await failureCode(validateLocalSubmission({
      mode: "prepublish", root: process.cwd(), io: localIo(files),
    }))).toBe("LOCAL_DEMO_CONTRACT");
  });

  it("parses a required Devpost section that is the final section at EOF", async () => {
    expect(submissionSection("# Draft\n\n## Final field\n\nLast body at EOF", "Final field"))
      .toBe("Last body at EOF");
  });

  it("rejects an unapproved publication placeholder", async () => {
    const files = await localCandidateFiles("prepublish");
    files.set("README.md", Buffer.concat([
      files.get("README.md")!, Buffer.from(`\n${["CLAIMGATE", "PUBLIC", "EXTRA", "PENDING"].join("_")}\n`),
    ]));

    expect(await failureCode(validateLocalSubmission({
      mode: "prepublish", root: process.cwd(), io: localIo(files),
    }))).toBe("LOCAL_PLACEHOLDER");
  });

  it("rejects every prepublish placeholder in final mode", async () => {
    const files = await localCandidateFiles("prepublish");
    expect(await failureCode(validateLocalSubmission({
      mode: "final", root: process.cwd(), io: localIo(files),
    }))).toBe("LOCAL_PLACEHOLDER");
  });

  it.each([
    [".env.local"], ["data/demo.db"], ["release/app.tar.gz"],
    ["notes/server-inventory-20260828.md"], ["keys/id_ed25519"],
  ])("rejects a forbidden public candidate path: %s", async (name) => {
    const files = await localCandidateFiles("prepublish");
    files.set(name, Buffer.from("not public\n"));
    expect(await failureCode(validateLocalSubmission({
      mode: "prepublish", root: process.cwd(), io: localIo(files),
    }))).toBe("LOCAL_FORBIDDEN_FILE");
  });

  it("rejects an absolute path returned as a public candidate", async () => {
    const files = await localCandidateFiles("prepublish");
    const absolute = ["C:", "Users", "person", "leak.txt"].join("/");
    files.set(absolute, Buffer.from("public-looking\n"));
    expect(await failureCode(validateLocalSubmission({
      mode: "prepublish", root: process.cwd(), io: localIo(files),
    }))).toBe("LOCAL_PUBLIC_FILE");
  });

  it.each([
    ["docs/private-note.md", `Saved at ${["C:", "Users", "person", "AppData", "Local", "Temp", "proof.txt"].join("\\")}\n`, "LOCAL_PRIVATE_PATH"],
    ["notes/deploy.md", `${["ssh", "-p", "32109", "demo@host.invalid"].join(" ")}\n`, "LOCAL_SSH_ENDPOINT"],
    ["notes/key.txt", `${["-----BEGIN", "PRIVATE", "KEY-----"].join(" ")}\nfixture\n`, "LOCAL_FORBIDDEN_FILE"],
    ["src/config.ts", `export const apiSecret = "${"A1b2C3d4E5f6G7h8".repeat(3)}";\n`, "LOCAL_SECRET"],
    ["config/release.env.example", `CLAIMGATE_API_KEY=${"A1b2C3d4E5f6G7h8".repeat(3)}\n`, "LOCAL_SECRET"],
  ])("rejects private publication material in %s", async (name, content, code) => {
    const files = await localCandidateFiles("prepublish");
    files.set(name, Buffer.from(content));

    expect(await failureCode(validateLocalSubmission({
      mode: "prepublish", root: process.cwd(), io: localIo(files),
    }))).toBe(code);
  });

  it("accepts the reviewed local package in prepublish mode", async () => {
    const files = await localCandidateFiles("prepublish");
    await expect(validateLocalSubmission({
      mode: "prepublish", root: process.cwd(), io: localIo(files),
    })).resolves.toEqual(expect.objectContaining({ mode: "prepublish" }));
  });
});

describe("submission validator CLI", () => {
  it("uses fixed one-line JSON output and bounded exit codes", async () => {
    let stdout = ""; let stderr = "";
    const validate = vi.fn(async () => ({ mode: "prepublish", filesChecked: 8 }));
    const code = await runSubmissionCli(["--prepublish"], {
      validate, writeOut: (value: string) => { stdout += value; },
      writeError: (value: string) => { stderr += value; },
    });
    expect({ code, stdout, stderr }).toEqual({
      code: 0,
      stdout: '{"submissionValidation":"PASS","mode":"prepublish"}\n',
      stderr: "",
    });
  });

  it("distinguishes usage errors from validation failures without details", async () => {
    let usage = ""; let failure = "";
    expect(await runSubmissionCli([], {
      validate: vi.fn(), writeOut: vi.fn(), writeError: (value: string) => { usage += value; },
    })).toBe(2);
    expect(usage).toBe('{"submissionValidation":"USAGE"}\n');
    expect(await runSubmissionCli(["--final"], {
      validate: vi.fn(async () => { throw Object.assign(new Error("secret body and path"), { code: "FINAL_ENV" }); }),
      writeOut: vi.fn(), writeError: (value: string) => { failure += value; },
    })).toBe(1);
    expect(failure).toBe('{"submissionValidation":"FAIL","mode":"final","code":"FINAL_ENV"}\n');
    expect(failure).not.toMatch(/secret|path|body/);
  });
});
