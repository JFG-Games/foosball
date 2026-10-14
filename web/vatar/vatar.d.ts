/**
 * Ambient types for the Lagos Life / Vatar Games browser SDK, matching
 * https://lagoslife.app/developers/docs (every method returns a Promise).
 */
export {};

declare global {
  interface VatarMatchInfo {
    id: string;
    code: string;
    status: "open" | "playing" | "done" | "cancelled" | "void";
    stake: number;
    seats: number;
    players: { id: string; name: string }[];
    me: string;
    winner: string | null;
    mode: string;
  }

  interface VatarSdk {
    /** Identity + short-lived session token (they expire after 15 minutes). */
    init(): Promise<{ player: { id: string; name: string; avatar?: string }; session: string; mode: string }>;
    /** A fresh session token. */
    session(): Promise<{ session: string; exp: number }>;
    /** Submit a score; the platform accepts one per player every 20 seconds. */
    submitScore(score: number): Promise<{ best: number; accepted: boolean }>;
    leaderboard(): Promise<{
      top: { rank: number; name: string; score: number }[];
      me: { rank: number; label: string; score: number } | null;
    }>;
    purchase(productId: string): Promise<{ purchaseId: string; productId: string }>;
    onPurchase(fn: (purchase: { purchaseId: string; productId: string }) => void): () => void;
    purchases(): Promise<{ purchaseId: string; productId: string }[]>;
    onPause(fn: () => void): () => void;
    onResume(fn: () => void): () => void;
    match: {
      current(): Promise<VatarMatchInfo | null>;
      leave(): Promise<VatarMatchInfo | null>;
      onUpdate(fn: (match: VatarMatchInfo) => void): () => void;
    };
  }

  interface Window {
    Vatar?: VatarSdk;
  }
}
