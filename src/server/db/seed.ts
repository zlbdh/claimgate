import type { PublicFoundItem } from "@/features/inventory/found-item";

type FoundItemSeed = Omit<PublicFoundItem, "publicTags"> & { readonly publicTags: readonly string[] };

export const NORTHBRIDGE_FOUND_ITEM_SEEDS: readonly FoundItemSeed[] = Object.freeze([
  {
    category: "earbuds",
    foundAt: "2026-08-25T18:10:00.000Z",
    area: "library",
    color: "black",
    publicTags: ["wireless", "charging-case", "compact"],
    publicDescription: "Black wireless earbud charging case found near the library reading room.",
  },
  {
    category: "earbuds",
    foundAt: "2026-08-25T17:40:00.000Z",
    area: "student-center",
    color: "black",
    publicTags: ["wireless", "oval-case"],
    publicDescription: "Black oval wireless earbud case found by the student center café.",
  },
  {
    category: "earbuds",
    foundAt: "2026-08-25T20:15:00.000Z",
    area: "library",
    color: "navy",
    publicTags: ["wireless", "charging-case"],
    publicDescription: "Navy earbud charging case found beside a library study booth.",
  },
  {
    category: "earbuds",
    foundAt: "2026-08-25T15:20:00.000Z",
    area: "park",
    color: "black",
    publicTags: ["wired", "zip-case"],
    publicDescription: "Black zip case containing wired earbuds found near the campus park.",
  },
  {
    category: "earbuds",
    foundAt: "2026-08-24T18:30:00.000Z",
    area: "library",
    color: "white",
    publicTags: ["wireless", "charging-case"],
    publicDescription: "White wireless earbud case found at the library help desk.",
  },
  {
    category: "earbuds",
    foundAt: "2026-08-25T18:50:00.000Z",
    area: "station",
    color: "gray",
    publicTags: ["wireless", "square-case"],
    publicDescription: "Gray square earbud case found near the campus shuttle station.",
  },
  {
    category: "earbuds",
    foundAt: "2026-08-25T21:00:00.000Z",
    area: "student-center",
    color: "silver",
    publicTags: ["wireless", "open-fit"],
    publicDescription: "Silver open-fit earbuds found in the student center lobby.",
  },
].map((item) => Object.freeze({ ...item, publicTags: Object.freeze([...item.publicTags]) })));
