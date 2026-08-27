import { validateDevpostEvidence } from "./submission-validation-devpost.mjs";
import { validatePublicArtifacts } from "./submission-validation-public.mjs";
import { fail, strictGitHubRepository, strictHttpsOrigin, strictYouTubeVideo } from "./submission-validation-shared.mjs";

function finalEnvironment(env) {
  const values = {
    live: env?.CLAIMGATE_PUBLIC_URL,
    repository: env?.CLAIMGATE_REPOSITORY_URL,
    video: env?.CLAIMGATE_VIDEO_URL,
    evidence: env?.CLAIMGATE_DEVPOST_EVIDENCE,
  };
  if (Object.values(values).some((value) => typeof value !== "string" || value.length === 0)) fail("FINAL_ENV");
  strictHttpsOrigin(values.live, "FINAL_URL");
  strictGitHubRepository(values.repository, "FINAL_URL");
  strictYouTubeVideo(values.video, "FINAL_URL");
  return values;
}

export async function validateExternalSubmission(options) {
  if (typeof options?.root !== "string" || typeof options?.fetch !== "function") fail("FINAL_ENV");
  const values = finalEnvironment(options.env);
  const urls = Object.freeze({ live: values.live, repository: values.repository, video: values.video });
  await validatePublicArtifacts({ root: options.root, fetch: options.fetch, lookup: options.lookup, urls });
  await validateDevpostEvidence({
    root: options.root, evidencePath: values.evidence, urls,
  });
  return Object.freeze({ externalChecks: 4 });
}
