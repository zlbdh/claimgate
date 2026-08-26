export function resolveModelContext(target: Document) {
  const context = target.modelContext;

  return context
    ? { supported: true as const, context }
    : { supported: false as const };
}
