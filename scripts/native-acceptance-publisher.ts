import { randomUUID } from "node:crypto";
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { basename, resolve, sep } from "node:path";
import { sha256 } from "./native-acceptance-contract";

const ARTIFACT_NAMES = Object.freeze([
  "run-1.json", "run-2.json", "run-3.json", "aggregate.json", "SHA256SUMS.txt",
]);

type PublisherIo = Readonly<{
  exists(path: string): boolean;
  mkdir(path: string): void;
  copy(source: string, destination: string): void;
  read(path: string): string;
  write(path: string, value: string): void;
  rename(source: string, destination: string): void;
  remove(path: string): void;
}>;

const realIo: PublisherIo = Object.freeze({
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  copy: copyFileSync,
  read: (path) => readFileSync(path, "utf8"),
  write: (path, value) => writeFileSync(path, value, "utf8"),
  rename: renameSync,
  remove: (path) => rmSync(path, { recursive: true, force: true }),
});

function within(path: string, root: string): string {
  const target = resolve(path);
  const boundary = resolve(root);
  if (target === boundary || !`${target}${sep}`.startsWith(`${boundary}${sep}`)) {
    throw new Error("Acceptance publication path escaped its transaction root");
  }
  return target;
}

export function publishNativeAcceptanceTransaction(input: Readonly<{
  transactionRoot: string;
  privateDir: string;
  evidenceDir: string;
  testingPath: string;
  testingMarkdown: string;
  io?: Partial<PublisherIo>;
}>): void {
  const io = Object.freeze({ ...realIo, ...input.io });
  const root = resolve(input.transactionRoot);
  const evidence = within(input.evidenceDir, root);
  const testing = within(input.testingPath, root);
  const suffix = randomUUID();
  const stagedEvidence = within(`${evidence}.stage-${suffix}`, root);
  const evidenceBackup = within(`${evidence}.backup-${suffix}`, root);
  const stagedTesting = within(`${testing}.stage-${suffix}`, root);
  const testingBackup = within(`${testing}.backup-${suffix}`, root);
  let evidenceBackedUp = false;
  let testingBackedUp = false;
  let evidencePublished = false;
  let testingPublished = false;
  let committed = false;
  io.mkdir(root);
  try {
    io.mkdir(stagedEvidence);
    for (const name of ARTIFACT_NAMES) {
      const source = resolve(input.privateDir, name);
      const destination = within(resolve(stagedEvidence, basename(name)), root);
      io.copy(source, destination);
      if (sha256(io.read(source)) !== sha256(io.read(destination))) {
        throw new Error("Copied acceptance artifact hash mismatch");
      }
    }
    io.write(stagedTesting, input.testingMarkdown);
    if (io.exists(evidence)) {
      io.rename(evidence, evidenceBackup);
      evidenceBackedUp = true;
    }
    if (io.exists(testing)) {
      io.rename(testing, testingBackup);
      testingBackedUp = true;
    }
    io.rename(stagedEvidence, evidence);
    evidencePublished = true;
    io.rename(stagedTesting, testing);
    testingPublished = true;
    committed = true;
  } catch (error) {
    if (committed) throw error;
    const rollbackErrors: unknown[] = [];
    try { if (testingPublished && io.exists(testing)) io.remove(testing); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
    try { if (evidencePublished && io.exists(evidence)) io.remove(evidence); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
    try { if (evidenceBackedUp && io.exists(evidenceBackup)) io.rename(evidenceBackup, evidence); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
    try { if (testingBackedUp && io.exists(testingBackup)) io.rename(testingBackup, testing); }
    catch (rollbackError) { rollbackErrors.push(rollbackError); }
    if (rollbackErrors.length > 0) {
      throw new AggregateError([error, ...rollbackErrors], "Acceptance publication rollback failed");
    }
    throw error;
  } finally {
    for (const path of [stagedEvidence, stagedTesting]) {
      if (io.exists(path)) io.remove(path);
    }
  }
  const cleanupErrors: unknown[] = [];
  for (const path of [evidenceBackup, testingBackup]) {
    if (!io.exists(path)) continue;
    try { io.remove(path); }
    catch (firstError) {
      if (!io.exists(path)) continue;
      try { io.remove(path); }
      catch (secondError) { cleanupErrors.push(new AggregateError([firstError, secondError])); }
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Acceptance committed but backup cleanup failed");
  }
}
