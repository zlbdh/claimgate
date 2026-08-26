import { expect, test } from "@playwright/test";

test("stores and returns the signed cookie through start and role switch forms", async ({
  context,
  page,
}) => {
  const homeResponse = await page.goto("/");
  expect(homeResponse?.headers()["referrer-policy"]).toBe("same-origin");
  await expect(page.getByRole("button", { name: "Start public demo" })).toBeVisible();

  const startResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/demo/start") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start public demo" }).click();
  const startResponse = await startResponsePromise;
  const startRequestHeaders = await startResponse.request().allHeaders();
  expect(startResponse.status()).toBe(303);
  expect(startRequestHeaders.origin).toBe("http://127.0.0.1:3100");
  expect(startRequestHeaders["sec-fetch-site"]).toBe("same-origin");
  await expect(page.getByText("Current role: Claimant")).toBeVisible();

  const [claimantCookie] = await context.cookies("http://127.0.0.1:3100");
  expect(claimantCookie).toMatchObject({
    name: "claimgate_session",
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  });
  expect(page.url()).not.toContain("localhost");

  const switchResponsePromise = page.waitForResponse((response) =>
    response.url().endsWith("/api/demo/switch-role") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Switch to Staff role" }).click();
  const switchResponse = await switchResponsePromise;
  const switchRequestHeaders = await switchResponse.request().allHeaders();
  expect(switchResponse.status()).toBe(303);
  expect(switchRequestHeaders.cookie).toContain(
    `claimgate_session=${claimantCookie.value}`,
  );
  expect(switchRequestHeaders.origin).toBe("http://127.0.0.1:3100");
  await expect(page.getByText("Current role: Staff")).toBeVisible();

  const [staffCookie] = await context.cookies("http://127.0.0.1:3100");
  expect(staffCookie.value).not.toBe(claimantCookie.value);
  await expect(page.getByText(
    "Public demo role switch — not production access control.",
  )).toBeVisible();
});
