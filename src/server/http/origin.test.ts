import { describe, expect, it } from "vitest";
import {
  parseAppOrigin,
  requireAuthenticatedWriteOrigin,
  requireDemoStartOrigin,
} from "./origin";

function headers(values: Record<string, string | undefined>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(values)) {
    if (value !== undefined) result.set(name, value);
  }
  return result;
}

describe("canonical APP_ORIGIN", () => {
  it.each([
    "http://127.0.0.1:3100",
    "https://demo.example.test",
    "http://[::1]:3100",
  ])("接受严格 canonical HTTP(S) origin：%s", (value) => {
    expect(parseAppOrigin(value).origin).toBe(value);
  });

  it.each([
    undefined,
    "",
    "ftp://example.test",
    "https://user@example.test",
    "https://example.test/",
    "https://example.test/path",
    "https://example.test?query=1",
    "https://example.test#fragment",
    "https://EXAMPLE.test",
    "https://example.test:443",
    " https://example.test",
  ])("拒绝非 canonical origin：%s", (value) => {
    expect(() => parseAppOrigin(value)).toThrow(
      expect.objectContaining({ code: "CONFIGURATION_ERROR" }),
    );
  });
});

describe("Origin/Host/Fetch Metadata", () => {
  it.each([
    ["example.test", "https://example.test"],
    ["example.test:443", "https://example.test"],
    ["EXAMPLE.TEST", "https://example.test"],
    ["[::1]:80", "http://[::1]"],
    ["[::1]", "http://[::1]"],
  ])("Host 规范化默认端口与 IPv6 后匹配：%s", (host, origin) => {
    expect(() => requireDemoStartOrigin(headers({
      host,
      origin,
      "sec-fetch-site": "same-origin",
    }), parseAppOrigin(origin))).not.toThrow();
  });

  it.each([
    { host: undefined, origin: "https://example.test", fetch: "same-origin" },
    { host: "example.test", origin: undefined, fetch: "same-origin" },
    { host: "example.test", origin: "null", fetch: "same-origin" },
    { host: "example.test", origin: "https://example.test, https://evil.test", fetch: "same-origin" },
    { host: "example.test", origin: "https://example.test/path", fetch: "same-origin" },
    { host: "example.test", origin: "http://example.test", fetch: "same-origin" },
    { host: "example.test", origin: "https://example.test:444", fetch: "same-origin" },
    { host: "sub.example.test", origin: "https://example.test", fetch: "same-origin" },
    { host: "example.test.evil", origin: "https://example.test", fetch: "same-origin" },
    { host: "example.test", origin: "https://sub.example.test", fetch: "same-origin" },
    { host: "example.test", origin: "https://example.test.evil", fetch: "same-origin" },
    { host: "example.test", origin: "https://example.test", fetch: undefined },
    { host: "example.test", origin: "https://example.test", fetch: "same-site" },
    { host: "example.test", origin: "https://example.test", fetch: "cross-site" },
    { host: "example.test", origin: "https://example.test", fetch: "none" },
  ])("无 CSRF 的 start 严格拒绝非法矩阵 %#", ({ host, origin, fetch }) => {
    expect(() => requireDemoStartOrigin(headers({
      host,
      origin,
      "sec-fetch-site": fetch,
      "x-forwarded-host": "example.test",
      "x-forwarded-proto": "https",
    }), parseAppOrigin("https://example.test"))).toThrow(
      expect.objectContaining({ code: "FORBIDDEN" }),
    );
  });

  it("authenticated write 可缺 Fetch Metadata，但 present 时只能 same-origin", () => {
    const origin = parseAppOrigin("https://example.test");
    expect(() => requireAuthenticatedWriteOrigin(headers({
      host: "example.test",
      origin: "https://example.test",
    }), origin)).not.toThrow();
    expect(() => requireAuthenticatedWriteOrigin(headers({
      host: "example.test",
      origin: "https://example.test",
      "sec-fetch-site": "same-origin",
    }), origin)).not.toThrow();
    expect(() => requireAuthenticatedWriteOrigin(headers({
      host: "example.test",
      origin: "https://example.test",
      "sec-fetch-site": "same-site",
    }), origin)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});
