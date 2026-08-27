import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CandidateFinder } from "./candidate-finder";

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function result(category: string, reportVersion: number) {
  return Response.json({
    reportVersion,
    candidates: [{
      candidateHandle: `cgch1.1.2.${(category === "earbuds" ? "A" : "B").repeat(43)}`,
      category, timeBand: "same window", area: "library", color: "black",
      confidence: "strong", reasons: ["category match"], expiresAt: 2,
    }],
    message: `${category} result`,
  });
}

afterEach(() => vi.restoreAllMocks());

describe("CandidateFinder request generation", () => {
  it("aborts the active request on unmount", async () => {
    let signal: AbortSignal | undefined;
    const pending = deferredResponse();
    const fetcher = vi.fn<typeof fetch>((_input, init) => {
      signal = init?.signal as AbortSignal;
      return pending.promise;
    });
    const view = render(<CandidateFinder reportId="report-a" reportVersion={2} fetcher={fetcher} />);
    fireEvent.click(screen.getByRole("button", { name: "Find candidates" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });

  it("ignores an old report response that finishes after the current report", async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = render(<CandidateFinder reportId="report-a" reportVersion={2} fetcher={fetcher} />);
    fireEvent.click(screen.getByRole("button", { name: "Find candidates" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());

    view.rerender(<CandidateFinder reportId="report-b" reportVersion={3} fetcher={fetcher} />);
    fireEvent.click(screen.getByRole("button", { name: "Find candidates" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    second.resolve(result("wallet", 3));
    await screen.findByText("wallet");
    first.resolve(result("earbuds", 2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText("earbuds")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("wallet result");
  });

  it("does not replace a current result when a stale request later fails", async () => {
    const first = deferredResponse();
    const fetcher = vi.fn<typeof fetch>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(result("wallet", 3));
    const view = render(<CandidateFinder reportId="report-a" reportVersion={2} fetcher={fetcher} />);
    fireEvent.click(screen.getByRole("button", { name: "Find candidates" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    view.rerender(<CandidateFinder reportId="report-b" reportVersion={3} fetcher={fetcher} />);
    fireEvent.click(screen.getByRole("button", { name: "Find candidates" }));
    await screen.findByText("wallet");
    first.resolve(new Response("private failure", { status: 500 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("wallet result");
  });
});
