export type RegistrationState = "registering" | "registered" | "error" | "idle";

const queues = new WeakMap<WebMCPModelContext, Promise<void>>();

function abortError(): DOMException {
  return new DOMException("Registration generation ended", "AbortError");
}

function enqueue(context: WebMCPModelContext, operation: () => Promise<void>): Promise<void> {
  const previous = queues.get(context) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(context, current.catch(() => undefined));
  return current;
}

export function createToolRegistrationManager(
  context: WebMCPModelContext,
  onState: (state: RegistrationState) => void = () => undefined,
) {
  let generation = 0;
  let currentController: AbortController | undefined;
  let last = Promise.resolve();
  let disposed = false;

  const replace = (tools: readonly WebMCPTool[]): Promise<void> => {
    currentController?.abort();
    const controller = new AbortController();
    currentController = controller;
    const ownGeneration = ++generation;
    if (!disposed) onState("registering");
    last = enqueue(context, async () => {
      try {
        for (const tool of tools) {
          if (controller.signal.aborted) throw abortError();
          await context.registerTool(tool, { signal: controller.signal });
        }
        if (!controller.signal.aborted && !disposed && ownGeneration === generation) {
          onState(tools.length > 0 ? "registered" : "idle");
        }
      } catch (error) {
        controller.abort();
        if (
          !disposed
          && ownGeneration === generation
          && !(error instanceof DOMException && error.name === "AbortError")
        ) onState("error");
      }
    });
    return last;
  };

  return Object.freeze({
    replace,
    dispose() {
      disposed = true;
      generation += 1;
      currentController?.abort();
    },
    settled: () => last,
  });
}
