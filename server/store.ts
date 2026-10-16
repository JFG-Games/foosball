import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * What each player owns, and which purchases have already been given out.
 *
 * A small JSON file, so there is no database to run. Hosts with an ephemeral
 * disk (Render's free tier, for one) wipe it on every deploy; point DATA_DIR
 * at a persistent disk, or swap this for a real database, before selling
 * anything for real money.
 */
interface Data {
  /** playerId -> product ids owned. */
  owned: Record<string, string[]>;
  /** Purchase ids already granted: the "once per purchase" guard. */
  granted: string[];
}

export class Store {
  private data: Data = { owned: {}, granted: [] };
  private readonly granted = new Set<string>();

  constructor(private readonly file: string | null) {
    if (file && existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Data>;
        this.data = { owned: parsed.owned ?? {}, granted: parsed.granted ?? [] };
      } catch (error) {
        console.warn("[store] could not read", file, error instanceof Error ? error.message : error);
      }
    }
    for (const id of this.data.granted) this.granted.add(id);
  }

  /** Give a player a product for a purchase. Returns false if that purchase was already granted. */
  grant(playerId: string, productId: string, purchaseId: string): boolean {
    if (this.granted.has(purchaseId)) return false;
    this.granted.add(purchaseId);
    this.data.granted.push(purchaseId);
    const items = (this.data.owned[playerId] ??= []);
    if (!items.includes(productId)) items.push(productId);
    this.save();
    return true;
  }

  items(playerId: string): string[] {
    return [...(this.data.owned[playerId] ?? [])];
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch (error) {
      console.warn("[store] could not save", error instanceof Error ? error.message : error);
    }
  }
}

/** The shared store. Set DATA_DIR to move it; "memory" keeps it in RAM only. */
const dir = process.env.DATA_DIR ?? "data";
export const store = new Store(dir === "memory" ? null : resolve(dir, "entitlements.json"));
