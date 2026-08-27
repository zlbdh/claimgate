import { validateExternalSubmission } from "./submission-validation-external.mjs";
import { validateLocalSubmission } from "./submission-validation-local.mjs";
import { fail } from "./submission-validation-shared.mjs";

export async function validateSubmission(options = {}) {
  const mode = options.mode;
  if (mode !== "prepublish" && mode !== "final") fail("USAGE");
  const root = options.root ?? process.cwd();
  const local = await (options.validateLocal ?? validateLocalSubmission)({
    mode, root, io: options.localIo,
  });
  if (mode === "final") {
    await (options.validateExternal ?? validateExternalSubmission)({
      root,
      env: options.env ?? process.env,
      fetch: options.fetch ?? globalThis.fetch,
    });
  }
  return Object.freeze({ mode, filesChecked: local.filesChecked });
}
