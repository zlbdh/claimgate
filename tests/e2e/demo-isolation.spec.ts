import { expect, test } from "@playwright/test";
import {
  createLostReportDraft,
  executeTool,
  installFaithfulModelContext,
  openClaimantDesk,
  startPublicDemo,
} from "./claim-gate-harness";

type ReportList = Readonly<{
  reports: readonly Readonly<{ reportId: string; status: string }>[];
}>;

const FORBIDDEN_INTERNAL_FIELDS = /inventoryItemId|catalogVersion|pickup_pass_digest/i;

test("separate browser contexts and a fresh restart never share demo state", async ({
  baseURL,
  browser,
  context: contextA,
  page: pageA,
}) => {
  test.setTimeout(90_000);
  if (!baseURL) throw new Error("Playwright baseURL is required");
  await installFaithfulModelContext(contextA);
  const contextB = await browser.newContext({ baseURL });
  try {
    await installFaithfulModelContext(contextB);
    const pageB = await contextB.newPage();
    await Promise.all([startPublicDemo(pageA), startPublicDemo(pageB)]);

    await openClaimantDesk(pageA);
    const reportA = await createLostReportDraft(pageA, "isolated A");
    await openClaimantDesk(pageB);
    const firstB = await executeTool<ReportList>(pageB, "list_my_reports", {});
    expect(firstB).toEqual({ ok: true, data: { reports: [] } });
    expect(JSON.stringify(firstB)).not.toContain(reportA.reportId);
    expect(JSON.stringify(firstB)).not.toMatch(FORBIDDEN_INTERNAL_FIELDS);

    await pageB.goto(`/claimant/reports/${reportA.reportId}`);
    await expect(pageB).toHaveURL(/\/claimant$/);
    await expect(pageB.locator("body")).not.toContainText("isolated A");

    await openClaimantDesk(pageB);
    const reportB = await createLostReportDraft(pageB, "isolated B before restart");
    await contextB.clearCookies();
    await startPublicDemo(pageB);
    await openClaimantDesk(pageB);
    const restartedB = await executeTool<ReportList>(pageB, "list_my_reports", {});
    expect(restartedB).toEqual({ ok: true, data: { reports: [] } });
    expect(JSON.stringify(restartedB)).not.toContain(reportA.reportId);
    expect(JSON.stringify(restartedB)).not.toContain(reportB.reportId);
    await pageB.goto(`/claimant/reports/${reportB.reportId}`);
    await expect(pageB).toHaveURL(/\/claimant$/);

    await openClaimantDesk(pageA);
    const stillA = await executeTool<ReportList>(pageA, "list_my_reports", {});
    expect(stillA.data.reports).toEqual([
      expect.objectContaining({ reportId: reportA.reportId, status: "DRAFT" }),
    ]);
    expect(JSON.stringify(stillA)).not.toMatch(FORBIDDEN_INTERNAL_FIELDS);
  } finally {
    await contextB.close();
  }
});
