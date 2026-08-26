export type PublicFoundItem = {
  category: string;
  foundAt: string;
  area: string;
  color: string;
  publicTags: string[];
  publicDescription: string;
};

/** Inventory records deliberately contain only fields safe for matching; secret evidence belongs elsewhere. */
export type FoundItem = PublicFoundItem & { candidateId: string };
