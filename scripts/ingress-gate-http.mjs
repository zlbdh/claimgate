import { createServer } from "node:http";
import { normalizeIngressSource } from "./ingress-gate-store.mjs";

const EXPECTED_HOST = "claimgate-ingress-gate";
const SOURCE_HEADER = "x-claimgate-source";
const ORIGIN_POLICY_HEADER = "x-claimgate-origin-policy";
const FETCH_POLICY_HEADER = "x-claimgate-fetch-policy";
const MAX_RETRY_SECONDS = 600;

function singleHeader(request, name) {
  let occurrences = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) occurrences += 1;
  }
  const value = request.headers[name];
  if (occurrences !== 1 || typeof value !== "string" || value.includes(",")) return undefined;
  return value;
}

function finish(response, status, retryAfterSeconds) {
  response.statusCode = status;
  response.setHeader("Cache-Control", "private, no-store");
  response.setHeader("Content-Length", "0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Connection", "close");
  if (retryAfterSeconds !== undefined) {
    response.setHeader("Retry-After", String(retryAfterSeconds));
  }
  response.end();
}

function trustedSubrequestShape(request) {
  return (
    request.method === "GET"
    && request.url === "/check"
    && singleHeader(request, "host") === EXPECTED_HOST
    && request.headers["transfer-encoding"] === undefined
    && (request.headers["content-length"] === undefined || request.headers["content-length"] === "0")
  );
}

export function createIngressGateHandler(options) {
  if (!options || typeof options.consume !== "function") throw new Error("Invalid ingress gate limiter");
  return function ingressGateHandler(request, response) {
    if (!trustedSubrequestShape(request)) {
      finish(response, 500);
      return;
    }
    if (
      singleHeader(request, ORIGIN_POLICY_HEADER) !== "1"
      || singleHeader(request, FETCH_POLICY_HEADER) !== "1"
    ) {
      finish(response, 401);
      return;
    }
    const source = singleHeader(request, SOURCE_HEADER);
    if (normalizeIngressSource(source) === undefined) {
      finish(response, 500);
      return;
    }
    try {
      const result = options.consume(source);
      if (
        !result
        || typeof result.allowed !== "boolean"
        || !Number.isSafeInteger(result.retryAfterMs)
        || result.retryAfterMs < 0
        || (result.allowed && result.retryAfterMs !== 0)
      ) throw new Error("Invalid ingress gate result");
      if (result.allowed) {
        finish(response, 204);
        return;
      }
      const retryAfter = Math.min(
        MAX_RETRY_SECONDS,
        Math.max(1, Math.ceil(result.retryAfterMs / 1_000)),
      );
      finish(response, 403, retryAfter);
    } catch {
      finish(response, 500);
    }
  };
}

export function createIngressGateServer(options) {
  const server = createServer({
    maxHeaderSize: 1_024,
    connectionsCheckingInterval: 500,
  }, createIngressGateHandler(options));
  server.maxHeadersCount = 32;
  server.requestTimeout = 2_000;
  server.headersTimeout = 2_000;
  server.keepAliveTimeout = 1_000;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    }
  });
  return server;
}
