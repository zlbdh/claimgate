import { DomainError } from "@/shared/domain-error";

type SameOriginWriteInput = {
  path: string;
  csrfToken: string;
  body: BodyInit;
  fetcher?: typeof fetch;
};

export async function performSameOriginWrite(input: SameOriginWriteInput): Promise<Response> {
  if (
    typeof input.path !== "string"
    || !input.path.startsWith("/api/")
    || input.path.includes("?")
    || input.path.includes("#")
    || input.path.includes("://")
    || input.path.startsWith("//")
    || typeof input.csrfToken !== "string"
    || input.csrfToken.length === 0
    || input.csrfToken.length > 1_024
  ) throw new DomainError("CONFIGURATION_ERROR");
  const headers = new Headers({ "X-CSRF-Token": input.csrfToken });
  return (input.fetcher ?? fetch)(input.path, {
    method: "POST",
    mode: "same-origin",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    headers,
    body: input.body,
  });
}
