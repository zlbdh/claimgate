import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  decodeUtf8, fail, fetchBounded, parseJson, sameTextArtifact, strictGitHubRepository, strictHttpsOrigin,
  strictYouTubeVideo,
} from "./submission-validation-shared.mjs";
import { assertPublicDns } from "./submission-validation-network.mjs";

const HEALTH_LIMIT = 512;
const GITHUB_API_LIMIT = 128 * 1024;
const README_LIMIT = 512 * 1024;
const LICENSE_LIMIT = 128 * 1024;
const OEMBED_LIMIT = 64 * 1024;
const WATCH_LIMIT = 4 * 1024 * 1024;

function exactMediaType(response, expected) {
  return response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() === expected;
}

async function validateLive(fetcher, liveValue) {
  const origin = strictHttpsOrigin(liveValue, "FINAL_URL");
  const url = new URL("/api/health", origin).href;
  const { response, bytes } = await fetchBounded(fetcher, url, {
    limit: HEALTH_LIMIT, code: "FINAL_LIVE", accept: "application/json",
  });
  if (response.status !== 200 || !exactMediaType(response, "application/json")
    || response.headers.get("cache-control") !== "private, no-store"
    || decodeUtf8(bytes, "FINAL_LIVE") !== '{"status":"healthy"}') fail("FINAL_LIVE");
}

async function validateRepository(fetcher, root, repositoryValue) {
  const { owner, repository } = strictGitHubRepository(repositoryValue, "FINAL_URL");
  const apiUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const repositoryResult = await fetchBounded(fetcher, apiUrl, {
    limit: GITHUB_API_LIMIT, code: "FINAL_REPOSITORY", accept: "application/vnd.github+json",
  });
  if (repositoryResult.response.status !== 200 || !exactMediaType(repositoryResult.response, "application/json")) {
    fail("FINAL_REPOSITORY");
  }
  const metadata = parseJson(repositoryResult.bytes, "FINAL_REPOSITORY");
  if (!metadata || typeof metadata !== "object" || metadata.private !== false
    || metadata.visibility !== "public" || metadata.default_branch !== "main"
    || metadata.license?.spdx_id !== "MIT") fail("FINAL_REPOSITORY");

  const rawBase = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/main`;
  const [remoteReadme, remoteLicense, localReadme, localLicense] = await Promise.all([
    fetchBounded(fetcher, `${rawBase}/README.md`, {
      limit: README_LIMIT, code: "FINAL_REPOSITORY_CONTENT", accept: "text/plain",
    }),
    fetchBounded(fetcher, `${rawBase}/LICENSE`, {
      limit: LICENSE_LIMIT, code: "FINAL_REPOSITORY_CONTENT", accept: "text/plain",
    }),
    readFile(path.join(root, "README.md")),
    readFile(path.join(root, "LICENSE")),
  ]).catch(() => fail("FINAL_REPOSITORY_CONTENT"));
  if (remoteReadme.response.status !== 200 || remoteLicense.response.status !== 200
    || !sameTextArtifact(remoteReadme.bytes, localReadme, "FINAL_REPOSITORY_CONTENT")
    || !sameTextArtifact(remoteLicense.bytes, localLicense, "FINAL_REPOSITORY_CONTENT")) {
    fail("FINAL_REPOSITORY_CONTENT");
  }
}

function balancedObject(text, start) {
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

function playerResponse(html) {
  const marker = "ytInitialPlayerResponse";
  const markerAt = html.indexOf(marker);
  if (markerAt < 0) fail("FINAL_VIDEO");
  const start = html.indexOf("{", markerAt + marker.length);
  if (start < 0) fail("FINAL_VIDEO");
  const source = balancedObject(html, start);
  if (!source) fail("FINAL_VIDEO");
  try { return JSON.parse(source); } catch { fail("FINAL_VIDEO"); }
}

function validPlayerMetadata(player, expectedVideoId) {
  const duration = Number(player?.videoDetails?.lengthSeconds);
  const renderer = player?.microformat?.playerMicroformatRenderer;
  const formats = player?.streamingData?.adaptiveFormats;
  const hasAudio = Array.isArray(formats) && formats.some((format) => (
    Number.isInteger(format?.audioChannels) && format.audioChannels > 0
    && typeof format.audioQuality === "string" && format.audioQuality.length > 0
    && /^audio\//i.test(format.mimeType ?? "")
  ));
  return player?.playabilityStatus?.status === "OK" && player?.videoDetails?.videoId === expectedVideoId
    && Number.isSafeInteger(duration) && duration > 0 && duration < 180
    && player?.videoDetails?.isLiveContent === false
    && renderer?.isUnlisted === false && hasAudio;
}

async function validateVideo(fetcher, videoValue) {
  const videoId = strictYouTubeVideo(videoValue, "FINAL_URL");
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(videoValue)}&format=json`;
  const oembed = await fetchBounded(fetcher, oembedUrl, {
    limit: OEMBED_LIMIT, code: "FINAL_VIDEO", accept: "application/json",
  });
  const metadata = parseJson(oembed.bytes, "FINAL_VIDEO");
  if (oembed.response.status !== 200 || metadata?.type !== "video"
    || metadata?.provider_name !== "YouTube" || typeof metadata?.title !== "string") fail("FINAL_VIDEO");
  const watch = await fetchBounded(fetcher, videoValue, {
    limit: WATCH_LIMIT, code: "FINAL_VIDEO", accept: "text/html",
  });
  if (watch.response.status !== 200
    || !validPlayerMetadata(playerResponse(decodeUtf8(watch.bytes, "FINAL_VIDEO")), videoId)) {
    fail("FINAL_VIDEO");
  }
}

export async function validatePublicArtifacts(options) {
  const live = strictHttpsOrigin(options.urls.live, "FINAL_URL");
  await assertPublicDns(live.hostname, options.lookup);
  await validateLive(options.fetch, options.urls.live);
  await validateRepository(options.fetch, options.root, options.urls.repository);
  await validateVideo(options.fetch, options.urls.video);
  return Object.freeze({ publicChecks: 3 });
}
