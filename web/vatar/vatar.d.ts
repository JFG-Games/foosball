/**
 * Minimal ambient types for the Lagos Life / Vatar Games browser SDK.
 * TODO: replace with the official type definitions once they ship.
 */
export {};

declare global {
  interface VatarLeaderboardEntry {
    displayName: string;
    score: number;
  }

  interface VatarSessionData {
    playerId: string;
    displayName: string;
    avatarUrl?: string;
    sessionToken: string;
  }

  interface VatarSdk {
    /** Identity + short-lived session token for the current player. */
    init(): Promise<VatarSessionData>;
    /** Submit a score to this game's best-score leaderboard. */
    submitScore(score: number): Promise<void>;
    /** Read the top entries plus the current player's rank (if any). */
    leaderboard(): Promise<{ entries: VatarLeaderboardEntry[]; playerRank?: number }>;
    /** Open the Lagos Life checkout for a product; returns the purchase id. */
    purchase(productId: string): Promise<{ id: string; status: string }>;
  }

  interface Window {
    Vatar?: VatarSdk;
  }
}
