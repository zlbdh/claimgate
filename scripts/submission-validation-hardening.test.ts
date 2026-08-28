import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { localCandidateFiles, localIo } from "./submission-validation-test-fixtures";
// @ts-expect-error The validator intentionally remains dependency-free JavaScript.
import { validateLocalSubmission } from "./submission-validation-local.mjs";
// @ts-expect-error The validator intentionally remains dependency-free JavaScript.
import { defaultLocalIo } from "./submission-validation-scan.mjs";

const temporary: string[] = [];
afterEach(async () => Promise.all(temporary.splice(0).map((target) => rm(target, { recursive: true, force: true }))));

async function code(promise: Promise<unknown>): Promise<string | undefined> {
  try { await promise; } catch (error) { return (error as { code?: string }).code; }
  return undefined;
}

async function validate(files: Map<string, Buffer>) {
  return validateLocalSubmission({ mode: "prepublish", root: process.cwd(), io: localIo(files) });
}

describe("secure public candidate filesystem", () => {
  it("rejects a candidate reported as a symbolic link before reading", async () => {
    const files = await localCandidateFiles("prepublish");
    files.set("notes/link.md", Buffer.from("safe text"));
    const io = localIo(files);
    io.inspectPublicFile = async (relative: string) => ({
      size: files.get(relative)!.byteLength, isFile: true,
      isSymbolicLink: relative === "notes/link.md", realPath: `/virtual/${relative}`,
    });
    expect(await code(validateLocalSubmission({ mode: "prepublish", root: process.cwd(), io })))
      .toBe("LOCAL_PUBLIC_FILE");
  });

  it("rejects a regular-looking file escaping through a directory junction", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "claimgate-junction-")); temporary.push(base);
    const root = path.join(base, "repo"); const outside = path.join(base, "outside");
    await mkdir(root); await mkdir(outside);
    await writeFile(path.join(outside, "leak.md"), "outside");
    await symlink(outside, path.join(root, "linked"), "junction");
    await expect(defaultLocalIo(root).readPublicFile("linked/leak.md"))
      .rejects.toMatchObject({ code: "LOCAL_PUBLIC_FILE" });
  });
});

describe("bounded candidate formats", () => {
  it.each([
    "bundle.zip", "bundle.7z", "bundle.rar", "bundle.tar", "bundle.gz", "bundle.xz",
    "state.db", "state.sqlite", "state.db.bak", "state.sqlite.backup",
  ])("rejects forbidden archive or database suffixes: %s", async (name) => {
    const files = await localCandidateFiles("prepublish"); files.set(`artifacts/${name}`, Buffer.from("text"));
    expect(await code(validate(files))).toBe("LOCAL_FORBIDDEN_FILE");
  });

  it.each([
    ["assets/opaque.bin", Buffer.from([0, 1, 2])],
    ["assets/invalid.custom", Buffer.from([0xff, 0xfe, 0xfd])],
    ["assets/huge.custom", Buffer.alloc(2 * 1024 * 1024 + 1, 0x61)],
    ["notes/not-approved.png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])],
    ["docs/submission/screenshots/bad.png", Buffer.from("not-png")],
  ])("rejects unknown binary, oversized, or unapproved image candidate: %s", async (name, body) => {
    const files = await localCandidateFiles("prepublish"); files.set(name, body);
    expect(await code(validate(files))).toBe("LOCAL_PUBLIC_FILE");
  });

  it("reads and scans an unknown UTF-8 extension instead of skipping it", async () => {
    const files = await localCandidateFiles("prepublish");
    files.set("notes/review.custom", Buffer.from(["D:", "workspace", "private.txt"].join("/")));
    expect(await code(validate(files))).toBe("LOCAL_PRIVATE_PATH");
  });
});

describe("private content detection", () => {
  it.each([
    ["drive workspace", ["D:", "workspace", "project", "private.txt"].join("/"), "LOCAL_PRIVATE_PATH"],
    ["UNC share", `\\\\${["fileserver", "private", "proof.txt"].join("\\")}`, "LOCAL_PRIVATE_PATH"],
    ["POSIX workspace", `/${["workspace", "project", "private.txt"].join("/")}`, "LOCAL_PRIVATE_PATH"],
    ["short secret", `deployPassword="${["A7!", "qP9$", "x"].join("")}"`, "LOCAL_SECRET"],
    ["ssh endpoint", ["ssh", ["deployer", "@", "prod", ".", "example", ".", "org"].join("")].join(" "), "LOCAL_SSH_ENDPOINT"],
    ["ssh endpoint with port", ["ssh", "-p", "2222", ["deployer", "@", "prod", ".", "example", ".", "org"].join("")].join(" "), "LOCAL_SSH_ENDPOINT"],
  ])("rejects %s", async (_label, content, expected) => {
    const files = await localCandidateFiles("prepublish"); files.set("notes/review.custom", Buffer.from(content));
    expect(await code(validate(files))).toBe(expected);
  });

  it("allows canonical synthetic path canaries and variable SSH placeholders", async () => {
    const files = await localCandidateFiles("prepublish");
    files.set("tests/canary.custom", Buffer.from([
      "C:/secret.db", "C:/private.db", "C:/Windows", "ssh $deployment_user@$deployment_host",
    ].join("\n")));
    await expect(validate(files)).resolves.toMatchObject({ mode: "prepublish" });
  });

  it.each([
    ["C:", "Windows", "System32"].join("/"),
    ["C:", "secret.db.backup"].join("/"),
    ["C:", "Program Files", "Git", "bin", "sh.exe", "..", "..", "escape"].join("/"),
  ])("does not allow a synthetic path as a prefix: %s", async (unsafe) => {
    const files = await localCandidateFiles("prepublish"); files.set("tests/bypass.custom", Buffer.from(unsafe));
    expect(await code(validate(files))).toBe("LOCAL_PRIVATE_PATH");
  });

  it.each([
    [["token", "="].join(""), ["closure", "evil", "A7!x"].join("-")].join('"') + '"',
    [["signing", "Key="].join(""), ["A7!", "qP9$", "x"].join("")].join('"') + '"',
    [["CLAIMGATE_BACKUP_", "TOKEN="].join(""), ["aB3$", "eF6&", "hJ9@"].join("")].join('"') + '"',
    [["key", "="].join(""), ["xQmT", "zLpR"].join("")].join('"') + '"',
    [["encryption", "Secret="].join(""), ["kR7!", "pQ2@", "vN9#", "xL4$"].join("")].join('"') + '"',
  ])("rejects fuzzy-canary or high-entropy secret assignment: %s", async (unsafe) => {
    const files = await localCandidateFiles("prepublish"); files.set("tests/secret-bypass.custom", Buffer.from(unsafe));
    expect(await code(validate(files))).toBe("LOCAL_SECRET");
  });

  it("allows only complete approved secret canary values", async () => {
    const files = await localCandidateFiles("prepublish");
    files.set("tests/approved-secret-canary.custom", Buffer.from([
      [["createCsrf", "Token="].join(""), ["closure", "create", "token"].join("-")].join('"') + '"',
      [["csrf", "Token="].join(""), "secret&targetRole=STAFF"].join('"') + '"',
      [["token", "="].join(""), "abcdefghijklmnopqrstuA"].join('"') + '"',
    ].join("\n")));
    await expect(validate(files)).resolves.toMatchObject({ mode: "prepublish" });
  });

  it.each([
    ["config/leak.yaml", [["pass", "word: "].join(""), ["AbCd", "EfGh"].join("")].join("")],
    ["notes/leak.md", [["to", "ken="].join(""), ["QwEr", "TyUi"].join("")].join("")],
    ["config/leak.conf", [["signing", "Key: "].join(""), ["ZxCv", "BnMm"].join("")].join("")],
  ])("rejects an unquoted identifier-shaped secret in %s", async (name, unsafe) => {
    const files = await localCandidateFiles("prepublish"); files.set(name, Buffer.from(unsafe));
    expect(await code(validate(files))).toBe("LOCAL_SECRET");
  });

  it.each([
    [["JWT_SIGNING", "_KEY"].join(""), ["RtYu", "IoPa"].join("")],
    [["SESSION_HMAC", "_KEY"].join(""), ["FgHj", "KlQw"].join("")],
    [["DATABASE_ENCRYPTION", "_KEY"].join(""), ["VbNm", "AsDf"].join("")],
  ])("rejects a prefixed semantic key name %s", async (keyName, secret) => {
    const files = await localCandidateFiles("prepublish");
    files.set("config/prefixed.yaml", Buffer.from(`${keyName}: ${secret}`));
    expect(await code(validate(files))).toBe("LOCAL_SECRET");
  });

  it("does not treat an ordinary word ending in key letters as a secret name", async () => {
    const files = await localCandidateFiles("prepublish");
    files.set("config/ordinary.yaml", Buffer.from(`mon${"key"}: ${["AbCd", "EfGh"].join("")}`));
    await expect(validate(files)).resolves.toMatchObject({ mode: "prepublish" });
  });

  it.each([
    ["config/dotted.yaml", [["pass", "word: "].join(""), ["Aa1", "bB2", "cC3"].join(".")].join("")],
    ["notes/punctuation.md", [["to", "ken="].join(""), ["Aa1", "bB2", "cC3"].join("?~")].join("")],
    ["config/colon.conf", [["signing", "Key: "].join(""), ["Aa1", "bB2"].join(":"), "#cC3"].join("")],
    ["config/hash.yaml", [["SESSION_HMAC", "_KEY: "].join(""), ["Aa1", "bB2"].join("#"), ".cC3"].join("")],
  ])("rejects a complete punctuation-bearing unquoted secret in %s", async (name, unsafe) => {
    const files = await localCandidateFiles("prepublish"); files.set(name, Buffer.from(unsafe));
    expect(await code(validate(files))).toBe("LOCAL_SECRET");
  });

  it("allows complete JS/TS member-chain references for sensitive variables", async () => {
    const files = await localCandidateFiles("prepublish");
    files.set("src/member-canary.ts", Buffer.from([
      "const token = form.csrfToken;",
      "const signingKey = process.env.CLAIMGATE_SIGNING_KEY;",
      "const password = runtime?.config?.password;",
    ].join("\n")));
    await expect(validate(files)).resolves.toMatchObject({ mode: "prepublish" });
  });

  it("scans TODO markers in every required document", async () => {
    const files = await localCandidateFiles("prepublish");
    const target = "docs/submission/testing.md";
    files.set(target, Buffer.concat([files.get(target)!, Buffer.from("\nTODO publication gap\n")]));
    expect(await code(validate(files))).toBe("LOCAL_PLACEHOLDER");
  });
});
