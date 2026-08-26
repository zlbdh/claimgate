import type { PublicInventoryItem, DemoInstance, RepositoryContext } from "./repository-types";
import { NORTHBRIDGE_FOUND_ITEM_SEEDS } from "./seed";
import { activeInstance, assertNoInternalInventoryIdentity, immediate, parseStringArray, requireInteger } from "./repository-internal";
import { appendInstanceAudit } from "./audit-repository";

const TWO_HOURS_MS = 2 * 60 * 60 * 1_000;

export function createDemoInstance(context: RepositoryContext): DemoInstance {
  return immediate(context, () => {
    const createdAtMs = context.now();
    requireInteger(createdAtMs);
    const instance: DemoInstance = {
      demoInstanceId: context.randomId(),
      createdAtMs,
      expiresAtMs: createdAtMs + TWO_HOURS_MS,
      catalogVersion: 1,
    };
    context.database.prepare(`
      INSERT INTO demo_instances (id, created_at_ms, expires_at_ms, catalog_version)
      VALUES (?, ?, ?, 1)
    `).run(instance.demoInstanceId, instance.createdAtMs, instance.expiresAtMs);
    const insertItem = context.database.prepare(`
      INSERT INTO found_items (
        demo_instance_id, id, category, found_at, area, color,
        public_tags_json, public_description, status, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'AVAILABLE', 1)
    `);
    for (const item of NORTHBRIDGE_FOUND_ITEM_SEEDS) {
      insertItem.run(
        instance.demoInstanceId,
        context.randomId(),
        item.category,
        item.foundAt,
        item.area,
        item.color,
        JSON.stringify(item.publicTags),
        item.publicDescription,
      );
    }
    appendInstanceAudit(context, instance.demoInstanceId, "DEMO_CREATED", "system");
    return instance;
  });
}

export function getDemoInstance(context: RepositoryContext, demoInstanceId: string): DemoInstance {
  return activeInstance(context, demoInstanceId);
}

export function deleteExpiredDemoInstances(context: RepositoryContext, atMs: number): number {
  requireInteger(atMs);
  return immediate(context, () => context.database.prepare(
    "DELETE FROM demo_instances WHERE expires_at_ms <= ?",
  ).run(atMs).changes);
}

export function listPublicInventory(
  context: RepositoryContext,
  demoInstanceId: string,
): PublicInventoryItem[] {
  activeInstance(context, demoInstanceId);
  const rows = context.database.prepare(`
    SELECT category, found_at AS foundAt, area, color,
      public_tags_json AS publicTagsJson, public_description AS publicDescription, status
    FROM found_items WHERE demo_instance_id = ? ORDER BY found_at, id
  `).all(demoInstanceId) as Array<Omit<PublicInventoryItem, "publicTags"> & { publicTagsJson: string }>;
  return rows.map(({ publicTagsJson, ...row }) => {
    const result = { ...row, publicTags: parseStringArray(publicTagsJson) };
    assertNoInternalInventoryIdentity(context, result, "CONFIGURATION_ERROR");
    return result;
  });
}
