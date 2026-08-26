export type PublicFoundItem = {
  category: string;
  foundAt: string;
  area: string;
  color: string;
  publicTags: string[];
  publicDescription: string;
};

/** Server-only match input. The inventory identity must never cross a browser/API boundary. */
export type FoundItem = PublicFoundItem & { inventoryItemId: string };
