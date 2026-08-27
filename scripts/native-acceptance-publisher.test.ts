import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { publishNativeAcceptanceTransaction } from "./native-acceptance-publisher";

const directories: string[] = [];
const names = ["run-1.json", "run-2.json", "run-3.json", "aggregate.json", "SHA256SUMS.txt"];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "native-publisher-test-"));
  directories.push(root);
  const privateDir = join(root, "private");
  const evidenceDir = join(root, "submission", "evidence", "native");
  const testingPath = join(root, "submission", "testing.md");
  mkdirSync(privateDir, { recursive: true });
  mkdirSync(evidenceDir, { recursive: true });
  mkdirSync(join(root, "submission"), { recursive: true });
  for (const name of names) writeFileSync(join(privateDir, name), `new-${name}`);
  writeFileSync(join(evidenceDir, "old.txt"), "old-evidence");
  writeFileSync(testingPath, "old-testing");
  return { root, privateDir, evidenceDir, testingPath };
}

function expectRolledBack(value: ReturnType<typeof fixture>): void {
  expect(readFileSync(join(value.evidenceDir, "old.txt"), "utf8")).toBe("old-evidence");
  expect(readFileSync(value.testingPath, "utf8")).toBe("old-testing");
  const names = readdirSync(join(value.root, "submission"), { recursive: true }) as string[];
  expect(names.filter((name) => /\.(?:stage|backup)-/.test(name))).toEqual([]);
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("native evidence and Markdown publication transaction", () => {
  it("restores both old targets when staged Markdown write fails", () => {
    const value = fixture();
    expect(() => publishNativeAcceptanceTransaction({
      transactionRoot: value.root,
      privateDir: value.privateDir,
      evidenceDir: value.evidenceDir,
      testingPath: value.testingPath,
      testingMarkdown: "new-testing",
      io: { write(path, text) {
        if (path.includes(".stage-")) throw new Error("injected Markdown write failure");
        writeFileSync(path, text, "utf8");
      } },
    })).toThrow(/injected Markdown write failure/);
    expectRolledBack(value);
  });

  it("restores both old targets when Markdown publish rename fails", () => {
    const value = fixture();
    expect(() => publishNativeAcceptanceTransaction({
      transactionRoot: value.root,
      privateDir: value.privateDir,
      evidenceDir: value.evidenceDir,
      testingPath: value.testingPath,
      testingMarkdown: "new-testing",
      io: { rename(source, destination) {
        if (source.includes("testing.md.stage-")) throw new Error("injected Markdown rename failure");
        renameSync(source, destination);
      } },
    })).toThrow(/injected Markdown rename failure/);
    expectRolledBack(value);
  });

  it("keeps the committed new pair when the second backup cleanup fails once", () => {
    const value = fixture();
    let backupCleanup = 0;
    expect(() => publishNativeAcceptanceTransaction({
      transactionRoot: value.root,
      privateDir: value.privateDir,
      evidenceDir: value.evidenceDir,
      testingPath: value.testingPath,
      testingMarkdown: "new-testing",
      io: { remove(path) {
        if (path.includes(".backup-")) {
          backupCleanup += 1;
          if (backupCleanup === 2) throw new Error("injected second backup cleanup failure");
        }
        rmSync(path, { recursive: true, force: true });
      } },
    })).not.toThrow();
    expect(readFileSync(value.testingPath, "utf8")).toBe("new-testing");
    for (const name of names) {
      expect(readFileSync(join(value.evidenceDir, name), "utf8")).toBe(`new-${name}`);
    }
    const entries = readdirSync(join(value.root, "submission"), { recursive: true }) as string[];
    expect(entries.filter((name) => /\.(?:stage|backup)-/.test(name))).toEqual([]);
  });

  it("reports persistent cleanup failure without deleting the committed pair", () => {
    const value = fixture();
    expect(() => publishNativeAcceptanceTransaction({
      transactionRoot: value.root,
      privateDir: value.privateDir,
      evidenceDir: value.evidenceDir,
      testingPath: value.testingPath,
      testingMarkdown: "new-testing",
      io: { remove(path) {
        if (path.includes("testing.md.backup-")) throw new Error("persistent cleanup failure");
        rmSync(path, { recursive: true, force: true });
      } },
    })).toThrow(/committed but backup cleanup failed/i);
    expect(readFileSync(value.testingPath, "utf8")).toBe("new-testing");
    for (const name of names) {
      expect(readFileSync(join(value.evidenceDir, name), "utf8")).toBe(`new-${name}`);
    }
    const entries = readdirSync(join(value.root, "submission"), { recursive: true }) as string[];
    expect(entries.filter((name) => /\.stage-/.test(name))).toEqual([]);
    expect(entries.filter((name) => /testing\.md\.backup-/.test(name))).toHaveLength(1);
  });
});
