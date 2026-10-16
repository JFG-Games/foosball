import { readStat, writeStat } from "./settings";
import { owns } from "./vatar/client";

/**
 * The shop catalogue.
 *
 * Every item is a one-off cosmetic: it never changes how the game plays. The id
 * must match a product created with the same id in the Vatar dashboard (made as
 * a one-off, not a consumable). Name, price and whether it is for sale always
 * come from Vatar's records, so no price is shown here.
 */
export type ShopKind = "kit" | "trail" | "party";

export interface ShopItem {
  id: string;
  kind: ShopKind;
  name: string;
  blurb: string;
  /** The colour it applies, and the swatch shown in the shop. */
  color: number;
}

export const SHOP: ShopItem[] = [
  { id: "gold_kit", kind: "kit", name: "Gold Kit", blurb: "Shiny gold players", color: 0xf2b705 },
  { id: "ice_kit", kind: "kit", name: "Ice Kit", blurb: "Cool icy-blue players", color: 0x19d3ff },
  { id: "pink_kit", kind: "kit", name: "Pink Kit", blurb: "Hot pink players", color: 0xff4fd8 },
  { id: "fire_trail", kind: "trail", name: "Fire Trail", blurb: "Flames follow the ball", color: 0xff7a1a },
  { id: "gold_party", kind: "party", name: "Gold Party", blurb: "Gold confetti when you score", color: 0xffd23f },
];

export const KIND_LABEL: Record<ShopKind, string> = {
  kit: "KITS",
  trail: "BALL TRAILS",
  party: "GOAL PARTIES",
};

/** Which item is chosen per kind. "" means the player turned it off on purpose. */
type Equipped = Partial<Record<ShopKind, string>>;

const readEquipped = (): Equipped => readStat<Equipped>("equipped", {});

/** The item in use for a kind: the chosen one, or (if never chosen) the first one owned. */
export function equippedFor(kind: ShopKind): ShopItem | null {
  const chosen = readEquipped()[kind];
  if (chosen === "") return null;
  const items = SHOP.filter((item) => item.kind === kind && owns(item.id));
  return items.find((item) => item.id === chosen) ?? (chosen === undefined ? (items[0] ?? null) : null);
}

export function equip(item: ShopItem): void {
  writeStat("equipped", { ...readEquipped(), [item.kind]: item.id });
}

export function unequip(kind: ShopKind): void {
  writeStat("equipped", { ...readEquipped(), [kind]: "" });
}
