import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Redis } from "ioredis";

/**
 * What each player owns, and which purchases have already been given out.
 *
 * Two backends behind one interface:
 *   - Redis, when REDIS_URL is set. Use this in production: it survives
 *     deploys, and `SADD` is atomic, so a purchase is granted exactly once even
 *     if the webhook and the player's own claim arrive together.
 *   - A JSON file, for local development. Hosts with an ephemeral disk
 *     (Render's free tier) wipe it on every deploy.
 */
export interface Store {
  /** Give a player a product for a purchase. Returns false if that purchase was already granted. */
  grant(playerId: string, productId: string, purchaseId: string): Promise<boolean>;
  /** Product ids a player owns. */
  items(playerId: string): Promise<string[]>;
}

/* ───────────────────────────── file / memory ───────────────────────────── */

interface Data {
  owned: Record<string, string[]>;
  granted: string[];
}

export class FileStore implements Store {
  private data: Data = { owned: {}, granted: [] };
  private readonly granted = new Set<string>();

  /** `file` null keeps everything in memory only. */
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

  async grant(playerId: string, productId: string, purchaseId: string): Promise<boolean> {
    if (this.granted.has(purchaseId)) return false;
    this.granted.add(purchaseId);
    this.data.granted.push(purchaseId);
    const items = (this.data.owned[playerId] ??= []);
    if (!items.includes(productId)) items.push(productId);
    this.save();
    return true;
  }

  async items(playerId: string): Promise<string[]> {
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

/* ──────────────────────────────── redis ──────────────────────────────── */

/** The slice of a Redis client the store needs (lets tests pass a fake). */
export interface RedisLike {
  sadd(key: string, member: string): Promise<number>;
  srem(key: string, member: string): Promise<number>;
  smembers(key: string): Promise<string[]>;
}

export class RedisStore implements Store {
  constructor(private readonly redis: RedisLike) {}

  async grant(playerId: string, productId: string, purchaseId: string): Promise<boolean> {
    // SADD returns 1 only for the first caller, so exactly one claim wins.
    const first = (await this.redis.sadd("foosball:granted", purchaseId)) === 1;
    if (!first) return false;
    try {
      await this.redis.sadd(`foosball:owned:${playerId}`, productId);
    } catch (error) {
      // Could not record the item: free the purchase id so a retry can grant it.
      await this.redis.srem("foosball:granted", purchaseId).catch(() => {});
      throw error;
    }
    return true;
  }

  items(playerId: string): Promise<string[]> {
    return this.redis.smembers(`foosball:owned:${playerId}`);
  }
}

/* ─────────────────────────────── the store ─────────────────────────────── */

function createStore(): Store {
  const url = process.env.REDIS_URL;
  if (url) {
    const redis = new Redis(url, { maxRetriesPerRequest: 2, enableReadyCheck: true });
    redis.on("error", (error: Error) => console.warn("[redis]", error.message));
    console.log("[store] using Redis");
    return new RedisStore(redis);
  }
  const dir = process.env.DATA_DIR ?? "data";
  console.log(dir === "memory" ? "[store] in memory only" : `[store] JSON file in ${dir}/ (use REDIS_URL in production)`);
  return new FileStore(dir === "memory" ? null : resolve(dir, "entitlements.json"));
}

export const store: Store = createStore();
