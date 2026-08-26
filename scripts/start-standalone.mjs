import { cp } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const standaloneRoot = path.resolve(".next", "standalone");

async function copyRuntimeAsset(source, destination) {
  try {
    await cp(source, destination, { recursive: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

await copyRuntimeAsset(
  path.resolve(".next", "static"),
  path.join(standaloneRoot, ".next", "static"),
);
await copyRuntimeAsset(path.resolve("public"), path.join(standaloneRoot, "public"));

process.env.PORT = process.env.PORT ?? "3100";
process.env.HOSTNAME = process.env.PLAYWRIGHT_HOSTNAME ?? "127.0.0.1";

await import(pathToFileURL(path.join(standaloneRoot, "server.js")).href);
