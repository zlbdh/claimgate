import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { scanPublicationText } from "./submission-validation-content.mjs";
import { approvedRepositoryImage, hasImageMagic, imageExtension, MAX_IMAGE_BYTES } from "./submission-validation-image.mjs";
import { decodeUtf8, fail, isInside } from "./submission-validation-shared.mjs";

const execute = promisify(execFile);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

function normalizeRelative(relative) {
  const normalized = relative.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\0")
    || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").includes("..")) fail("LOCAL_PUBLIC_FILE");
  return normalized;
}

export function defaultLocalIo(root) {
  const canonicalRoot = realpath(root).catch(() => fail("LOCAL_ROOT"));
  async function inspectPublicFile(relative) {
    const realRoot = await canonicalRoot;
    const absolute = path.resolve(realRoot, relative);
    if (!isInside(realRoot, absolute)) fail("LOCAL_PUBLIC_FILE");
    try {
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink() || !metadata.isFile()) fail("LOCAL_PUBLIC_FILE");
      const target = await realpath(absolute);
      if (!isInside(realRoot, target) || path.normalize(target) !== path.normalize(absolute)) fail("LOCAL_PUBLIC_FILE");
      return { size: metadata.size, isFile: true, isSymbolicLink: false, realPath: target };
    } catch (error) {
      if (error?.code === "LOCAL_PUBLIC_FILE") throw error;
      fail("LOCAL_PUBLIC_FILE");
    }
  }
  return {
    async listPublicFiles() {
      try {
        const { stdout } = await execute("git", [
          "ls-files", "-z", "--cached", "--others", "--exclude-standard",
        ], { cwd: await canonicalRoot, encoding: "buffer", maxBuffer: 4 * 1024 * 1024, windowsHide: true });
        return stdout.toString("utf8").split("\0").filter(Boolean);
      } catch { fail("LOCAL_GIT_FILES"); }
    },
    inspectPublicFile,
    async readPublicFile(relative) {
      const metadata = await inspectPublicFile(relative);
      try {
        const bytes = await readFile(metadata.realPath);
        if (bytes.byteLength !== metadata.size) fail("LOCAL_PUBLIC_FILE");
        return bytes;
      } catch (error) {
        if (error?.code === "LOCAL_PUBLIC_FILE") throw error;
        fail("LOCAL_PUBLIC_FILE");
      }
    },
  };
}

function forbiddenFile(relative) {
  const lower = relative.toLowerCase();
  const base = path.posix.basename(lower);
  if (base === ".env" || (base.startsWith(".env.") && base !== ".env.example")) return true;
  if (/(?:^|\.)(?:zip|7z|rar|tar|tgz|gz|xz|db|sqlite|sqlite3|pem|key|p12|pfx)(?:[.-]|$)/.test(base)) return true;
  if (/^(?:id_rsa|id_ed25519)(?:\.|$)/.test(base)) return true;
  return /(?:^|\/)(?:server|private)[-_]inventory(?:[-_.\/]|$)|(?:^|\/)claimgate-private(?:\/|$)/.test(lower);
}

export async function scanPublicCandidates(io) {
  const listed = await io.listPublicFiles();
  const files = [...new Set(listed.map(normalizeRelative))].sort();
  if (files.length < 1 || files.length > 10_000) fail("LOCAL_PUBLIC_FILE");
  const texts = new Map();
  for (const relative of files) {
    const metadata = await io.inspectPublicFile(relative);
    if (!metadata?.isFile || metadata.isSymbolicLink || !Number.isSafeInteger(metadata.size) || metadata.size < 1) {
      fail("LOCAL_PUBLIC_FILE");
    }
    if (forbiddenFile(relative)) fail("LOCAL_FORBIDDEN_FILE");
    const extension = imageExtension(relative);
    const limit = extension ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
    if (metadata.size > limit) fail("LOCAL_PUBLIC_FILE");
    const bytes = await io.readPublicFile(relative);
    if (bytes.byteLength !== metadata.size) fail("LOCAL_PUBLIC_FILE");
    if (extension) {
      if (!approvedRepositoryImage(relative) || !hasImageMagic(bytes, extension)) fail("LOCAL_PUBLIC_FILE");
      continue;
    }
    if (bytes.includes(0)) fail("LOCAL_PUBLIC_FILE");
    const text = decodeUtf8(bytes, "LOCAL_PUBLIC_FILE");
    scanPublicationText(text, { file: relative });
    texts.set(relative, text);
  }
  return { files, texts };
}
