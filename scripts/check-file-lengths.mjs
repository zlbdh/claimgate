import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const roots = ["src", "tests", "scripts"];
const checkedExtensions = new Set([".css", ".js", ".mjs", ".mts", ".ts", ".tsx"]);

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      return entry.isDirectory() ? collectFiles(absolute) : [absolute];
    }),
  );
  return nested.flat();
}

const availableRoots = [];
for (const root of roots) {
  try {
    await readdir(root);
    availableRoots.push(root);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

const files = (await Promise.all(availableRoots.map(collectFiles)))
  .flat()
  .filter((file) => checkedExtensions.has(path.extname(file)));

let failed = false;
for (const file of files.sort()) {
  const lineCount = (await readFile(file, "utf8")).split(/\r?\n/).length;
  const relative = path.relative(process.cwd(), file);
  console.log(`${lineCount.toString().padStart(4)} ${relative}`);

  if (lineCount > 1_000) {
    failed = true;
    console.error(`Prohibited: ${relative} exceeds 1,000 lines and must be split.`);
  } else if (lineCount > 500) {
    failed = true;
    console.error(`Failed: ${relative} exceeds 500 lines. Provide sufficient justification before adjusting the gate.`);
  } else if (lineCount > 300) {
    console.warn(`Reminder: ${relative} has ${lineCount} lines. Evaluate splitting it.`);
  }
}

if (failed) process.exitCode = 1;
