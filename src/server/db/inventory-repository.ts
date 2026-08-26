import type {
  RepositoryContext,
  ServerInternalFoundItemMutationResult,
  ServerInternalFoundItem,
  UpdateFoundItemInput,
} from "./repository-types";
import { DomainError } from "@/shared/domain-error";
import { appendInstanceAudit } from "./audit-repository";
import {
  activeInstance,
  assertNoInternalInventoryIdentity,
  immediate,
  parseStringArray,
  requireActor,
  requirePatchKeys,
  stateChanged,
  validatePublicTags,
} from "./repository-internal";

type ItemRow = Omit<ServerInternalFoundItem, "publicTags"> & { publicTagsJson: string };

function toRecord(row: ItemRow): ServerInternalFoundItem {
  const { publicTagsJson, ...record } = row;
  return { ...record, publicTags: parseStringArray(publicTagsJson) };
}

function toSafeInternalRecord(
  context: RepositoryContext,
  demoInstanceId: string,
  row: ItemRow,
): ServerInternalFoundItem {
  const record = toRecord(row);
  const { inventoryItemId, ...publicFields } = record;
  assertNoInternalInventoryIdentity(context, publicFields, "CONFIGURATION_ERROR");
  return { inventoryItemId, ...publicFields };
}

const ITEM_SELECT = `
  SELECT id AS inventoryItemId, category, found_at AS foundAt, area, color,
    public_tags_json AS publicTagsJson, public_description AS publicDescription,
    status, version FROM found_items
`;

export function listServerInternalFoundItems(
  context: RepositoryContext,
  demoInstanceId: string,
): ServerInternalFoundItem[] {
  activeInstance(context, demoInstanceId);
  return (context.database.prepare(`${ITEM_SELECT} WHERE demo_instance_id = ? ORDER BY id`)
    .all(demoInstanceId) as ItemRow[]).map((row) => toSafeInternalRecord(context, demoInstanceId, row));
}

function getItem(
  context: RepositoryContext,
  demoInstanceId: string,
  inventoryItemId: string,
): ServerInternalFoundItem | undefined {
  const row = context.database.prepare(`${ITEM_SELECT} WHERE demo_instance_id = ? AND id = ?`)
    .get(demoInstanceId, inventoryItemId) as ItemRow | undefined;
  return row ? toSafeInternalRecord(context, demoInstanceId, row) : undefined;
}

export function updateFoundItem(
  context: RepositoryContext,
  input: UpdateFoundItemInput,
): ServerInternalFoundItemMutationResult {
  return immediate(context, () => {
    activeInstance(context, input.demoInstanceId);
    const actorId = requireActor(input.actorId);
    if (actorId !== "staff-demo") throw new DomainError("VALIDATION_FAILED");
    requirePatchKeys(input.patch, ["area", "color", "foundAt", "publicTags", "publicDescription"]);
    if (input.patch.publicTags !== undefined) {
      validatePublicTags(input.patch.publicTags, "VALIDATION_FAILED");
    }
    assertNoInternalInventoryIdentity(context, input.patch, "VALIDATION_FAILED");
    const existing = getItem(context, input.demoInstanceId, input.inventoryItemId);
    if (!existing || existing.version !== input.expectedVersion) stateChanged();
    const next = { ...existing, ...input.patch };
    const result = context.database.prepare(`
      UPDATE found_items SET found_at = ?, area = ?, color = ?, public_tags_json = ?,
        public_description = ?, status = ?, version = version + 1
      WHERE demo_instance_id = ? AND id = ? AND version = ?
    `).run(
      next.foundAt,
      next.area,
      next.color,
      JSON.stringify(next.publicTags),
      next.publicDescription,
      next.status,
      input.demoInstanceId,
      input.inventoryItemId,
      input.expectedVersion,
    );
    if (result.changes !== 1) stateChanged();
    const catalog = context.database.prepare(`
      UPDATE demo_instances SET catalog_version = catalog_version + 1
      WHERE id = ? AND expires_at_ms > ? RETURNING catalog_version AS catalogVersion
    `).get(input.demoInstanceId, context.now()) as { catalogVersion: number } | undefined;
    if (!catalog) stateChanged();
    appendInstanceAudit(context, input.demoInstanceId, "INVENTORY_UPDATED", actorId);
    return { ...getItem(context, input.demoInstanceId, input.inventoryItemId)!, ...catalog };
  });
}
