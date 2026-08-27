import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type TarEntry = {
  body?: Buffer;
  declaredSize?: number;
  gnu?: boolean;
  link?: string;
  name: string;
  prefix?: string;
  type?: string;
};
type Python = { command: string; prefix: string[] };

const temporaryDirectories: string[] = [];
const cli = path.join(process.cwd(), "scripts", "validate-release-archive.py");
let python: Python;

function discoverPython(): Python {
  for (const candidate of [
    { command: "python", prefix: [] },
    { command: "python3", prefix: [] },
    { command: "py", prefix: ["-3"] },
  ]) {
    const probe = spawnSync(candidate.command, [...candidate.prefix, "-c", "import sys; assert sys.version_info[:2] == (3, 11)"],
      { encoding: "utf8", windowsHide: true });
    if (probe.status === 0) return candidate;
  }
  throw new Error("Python 3.11+ is required for archive validation tests");
}

function writeText(target: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value);
  if (bytes.length > length) throw new Error("fixture field is too long");
  bytes.copy(target, offset);
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  if (text.length >= length) throw new Error("fixture number is too large");
  writeText(target, offset, length, `${text}\0`);
}

function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512);
  writeText(header, 0, 100, entry.name);
  writeOctal(header, 100, 8, 0o755);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.declaredSize ?? entry.body?.length ?? 0);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  writeText(header, 156, 1, entry.type ?? "0");
  writeText(header, 157, 100, entry.link ?? "");
  writeText(header, 257, 6, entry.gnu ? "ustar " : "ustar\0");
  writeText(header, 263, 2, entry.gnu ? " \0" : "00");
  writeText(header, 345, 155, entry.prefix ?? "");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeText(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function tar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.body ?? Buffer.alloc(0);
    parts.push(tarHeader(entry), body);
    const padding = (512 - (body.length % 512)) % 512;
    if (padding) parts.push(Buffer.alloc(padding));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

function paxRecord(key: string, value: string): Buffer {
  let length = Buffer.byteLength(` ${key}=${value}\n`) + 1;
  while (true) {
    const record = Buffer.from(`${length} ${key}=${value}\n`);
    if (record.length === length) return record;
    length = record.length;
  }
}

async function fixture(content: Buffer, compress = true): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "claimgate-archive-"));
  temporaryDirectories.push(directory);
  const archive = path.join(directory, "release.tar.gz");
  await writeFile(archive, compress ? gzipSync(content) : content);
  return archive;
}

function run(archive: string, strip = 0) {
  return spawnSync(python.command, [...python.prefix, cli, archive, String(strip)], {
    encoding: "utf8", windowsHide: true,
  });
}

async function rejects(entries: TarEntry[]): Promise<void> {
  const result = run(await fixture(tar(entries)));
  expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
    status: 1, stderr: "Release archive validation failed.\n", stdout: "",
  });
}

beforeAll(() => { python = discoverPython(); });
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })));
});

describe("release archive validator", () => {
  it("accepts safe ustar, GNU longname/longlink, and PAX path/linkpath", async () => {
    const longName = `app/${"nested/".repeat(18)}payload.txt`;
    const pax = Buffer.concat([paxRecord("path", "pax/alias"),
      paxRecord("linkpath", "target.txt"), paxRecord("mtime", "0.123")]);
    const archive = await fixture(tar([
      { name: "./", type: "5" },
      { name: "app/", type: "5" },
      { body: Buffer.from("safe"), name: "data.txt", prefix: "app" },
      { link: "app/data.txt", name: "app/copy.txt", type: "1" },
      { name: "app/bin/", type: "5" },
      { link: "../data.txt", name: "app/bin/tool", type: "2" },
      { body: Buffer.from(`${longName}\0`), gnu: true, name: "././@LongLink", type: "L" },
      { body: Buffer.from("long"), gnu: true, name: "placeholder" },
      { body: Buffer.from("target"), name: "pax/target.txt" },
      { body: pax, name: "PaxHeaders/alias", type: "x" },
      { link: "ignored", name: "ignored", type: "2" },
      { body: Buffer.from("target.txt\0"), name: "././@LongLink", type: "K" },
      { link: "ignored", name: "pax/gnu-link", type: "2" },
    ]));
    const result = run(archive);
    expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
      status: 0, stderr: "", stdout: "Release archive is safe.\n",
    });
  });

  it.each(["/etc/passwd", "../escape", "a/../../escape", "C:/Windows", "C:relative", "a\\b"])(
    "rejects unsafe member path %s",
    async (name) => rejects([{ body: Buffer.from("x"), name }]),
  );

  it("validates GNU longname and PAX path overrides", async () => {
    await rejects([{ body: Buffer.from("../gnu-escape\0"), name: "././@LongLink", type: "L" },
      { body: Buffer.from("x"), name: "safe" }]);
    const pax = paxRecord("path", "../pax-escape");
    await rejects([{ body: pax, name: "PaxHeaders/x", type: "x" }, { name: "safe" }]);
  });

  it.each(["/etc/shadow", "../../escape", "C:/Windows", "a\\b"])(
    "rejects unsafe symlink target %s",
    async (link) => rejects([{ link, name: "app/link", type: "2" }]),
  );

  it("validates hardlink, GNU longlink, and PAX linkpath targets", async () => {
    await rejects([{ link: "../outside", name: "copy", type: "1" }]);
    await rejects([{ body: Buffer.from("../../outside\0"), name: "././@LongLink", type: "K" },
      { link: "safe", name: "app/link", type: "2" }]);
    const pax = paxRecord("linkpath", "/outside");
    await rejects([{ body: pax, name: "PaxHeaders/x", type: "x" },
      { link: "safe", name: "app/link", type: "2" }]);
  });

  it.each(["3", "4", "6", "7"])("rejects special type %s", async (type) =>
    rejects([{ name: "device", type }]));

  it("rejects duplicate paths and non-directory ancestors in either order", async () => {
    await rejects([{ name: "a" }, { name: "./a" }]);
    await rejects([{ name: "a" }, { name: "a/child" }]);
    await rejects([{ name: "a/child" }, { link: "child", name: "a", type: "2" }]);
  });

  it("rejects bad gzip/checksums, truncation, and post-terminator data", async () => {
    expect(run(await fixture(Buffer.from("not gzip"), false)).status).toBe(1);
    const corrupt = tar([{ body: Buffer.from("x"), name: "safe" }]);
    corrupt[0] ^= 1;
    expect(run(await fixture(corrupt)).status).toBe(1);
    const complete = tar([{ body: Buffer.from("x"), name: "safe" }]);
    expect(run(await fixture(complete.subarray(0, -512))).status).toBe(1);
    expect(run(await fixture(Buffer.concat([complete, Buffer.from([1])]))).status).toBe(1);
  });

  it("rejects malformed/dangling extensions and oversized declared members", async () => {
    await rejects([{ body: Buffer.from("8 path=x\n"), name: "PaxHeaders/x", type: "x" },
      { name: "safe" }]);
    await rejects([{ body: Buffer.from("unused\0"), name: "././@LongLink", type: "L" }]);
    await rejects([{ declaredSize: 1_073_741_825, name: "large" }]);
  });

  it("strictly rejects Solaris/PAX and GNU extension payload ambiguity", async () => {
    await rejects([{ body: Buffer.alloc(1_048_577, 0x61), name: "SolarisHead/x", type: "X" },
      { name: "safe" }]);
    await rejects([{ body: Buffer.from("app/no-terminator"), name: "././@LongLink", type: "L" },
      { body: Buffer.from("x"), name: "safe" }]);
    await rejects([{ body: Buffer.from("app/name\0garbage"), name: "././@LongLink", type: "L" },
      { body: Buffer.from("x"), name: "safe" }]);
    await rejects([{ body: Buffer.concat([paxRecord("path", "safe"), Buffer.from("garbage")]),
      name: "PaxHeaders/x", type: "x" }, { name: "ignored" }]);
  });

  it("rejects malformed or unbounded PAX numeric fields", async () => {
    for (const [key, value] of [
      ["size", "not-a-number"], ["uid", "-1"], ["gid", "9".repeat(80)], ["mtime", "nan"],
    ]) {
      await rejects([{ body: paxRecord(key, value), name: "PaxHeaders/x", type: "x" },
        { name: "safe" }]);
    }
  });

  it("rejects GNU sparse markers before tarfile can parse sparse maps", async () => {
    const probe = [
      "import base64, importlib.util, sys",
      'spec = importlib.util.spec_from_file_location("validator", sys.argv[1])',
      "module = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(module)",
      "try:",
      "    (module._BoundedTarInfo.frombuf(base64.b64decode(sys.argv[3]), 'utf-8', 'strict')",
      "     if sys.argv[2] == 'header' else module._strict_pax_extension(base64.b64decode(sys.argv[3])))",
      "except module.UnsafeArchive:",
      "    raise SystemExit(0)",
      "raise SystemExit(1)",
    ].join("\n");
    const sparseHeader = tarHeader({ name: "sparse", type: "S" }).toString("base64");
    const paxSparse = paxRecord("GNU.sparse.major", "1").toString("base64");
    for (const [operation, payload] of [["header", sparseHeader], ["pax", paxSparse]]) {
      const result = spawnSync(python.command, [...python.prefix, "-c", probe, cli, operation, payload],
        { encoding: "utf8", windowsHide: true });
      expect({ status: result.status, stderr: result.stderr, stdout: result.stdout })
        .toEqual({ status: 0, stderr: "", stdout: "" });
    }
    await rejects([{ name: "sparse", type: "S" }]);
    const pax = Buffer.concat([paxRecord("GNU.sparse.major", "1"),
      paxRecord("GNU.sparse.minor", "0"), paxRecord("GNU.sparse.realsize", "1")]);
    await rejects([{ body: pax, name: "PaxHeaders/sparse", type: "x" }, { name: "safe" }]);
  });

  it("validates nine thousand sibling members within a bounded time and rejects over-limit count", async () => {
    const entries = Array.from({ length: 9_000 }, (_, index) => ({ name: `files/${index}.txt` }));
    const archive = await fixture(tar([{ name: "files/", type: "5" }, ...entries]));
    const started = Date.now();
    const result = spawnSync(python.command, [...python.prefix, cli, archive, "0"], {
      encoding: "utf8", timeout: 3_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
      status: 0, stderr: "", stdout: "Release archive is safe.\n",
    });
    expect(Date.now() - started).toBeLessThan(3_000);
    const excess = Array.from({ length: 10_001 }, (_, index) => ({ name: `excess/${index}` }));
    await rejects([{ name: "excess/", type: "5" }, ...excess]);
  }, 12_000);

  it("uses fixed failure output without archive or member details", async () => {
    const archive = await fixture(tar([{ name: "../secret-name" }]));
    const result = run(archive);
    expect({ status: result.status, stderr: result.stderr, stdout: result.stdout }).toEqual({
      status: 1, stderr: "Release archive validation failed.\n", stdout: "",
    });
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/secret-name|claimgate-archive-/);
  });

  it("applies strip-components before resolving symlink targets", async () => {
    const archive = await fixture(tar([
      { name: "top/", type: "5" },
      { name: "top/link", type: "2", link: "../escape" },
    ]));
    expect(run(archive, 1).status).toBe(1);
  });
});
