import { validateSubmissionCopy, REQUIRED_SUBMISSION_FILES } from "./submission-validation-copy.mjs";
import { defaultLocalIo, scanPublicCandidates } from "./submission-validation-scan.mjs";
import { fail } from "./submission-validation-shared.mjs";

export async function validateLocalSubmission(options) {
  const mode = options?.mode;
  if (mode !== "prepublish" && mode !== "final") fail("USAGE");
  const root = options.root;
  if (typeof root !== "string" || root.length === 0) fail("LOCAL_ROOT");
  const io = options.io ?? defaultLocalIo(root);
  const scanned = await scanPublicCandidates(io);
  const required = new Map();
  for (const file of REQUIRED_SUBMISSION_FILES) {
    if (!scanned.files.includes(file)) fail("LOCAL_REQUIRED_FILE");
    try { required.set(file, await io.readPublicFile(file)); } catch { fail("LOCAL_REQUIRED_FILE"); }
  }
  validateSubmissionCopy(mode, required, scanned.texts);
  return Object.freeze({ mode, filesChecked: scanned.files.length });
}
