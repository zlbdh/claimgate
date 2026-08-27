import { pathToFileURL } from "node:url";
import { validateSubmission } from "./submission-validation-core.mjs";

const USAGE = '{"submissionValidation":"USAGE"}\n';

function modeFromArgs(args) {
  if (args.length !== 1) return undefined;
  if (args[0] === "--prepublish") return "prepublish";
  if (args[0] === "--final") return "final";
  return undefined;
}

function boundedCode(error) {
  const value = error?.code;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(value) ? value : "INTERNAL";
}

export async function runSubmissionCli(args, dependencies = {}) {
  const writeOut = dependencies.writeOut ?? ((value) => process.stdout.write(value));
  const writeError = dependencies.writeError ?? ((value) => process.stderr.write(value));
  const mode = modeFromArgs(args);
  if (!mode) { writeError(USAGE); return 2; }
  try {
    await (dependencies.validate ?? validateSubmission)({
      mode,
      root: dependencies.root ?? process.cwd(),
      env: dependencies.env ?? process.env,
      fetch: dependencies.fetch ?? globalThis.fetch,
    });
    writeOut(JSON.stringify({ submissionValidation: "PASS", mode }) + "\n");
    return 0;
  } catch (error) {
    writeError(JSON.stringify({ submissionValidation: "FAIL", mode, code: boundedCode(error) }) + "\n");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runSubmissionCli(process.argv.slice(2));
}
