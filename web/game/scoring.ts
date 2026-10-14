import type { Difficulty } from "@shared/bot";
import type { Team } from "@shared/constants";

/**
 * Leaderboard points for a finished match.
 *
 * Goals always count, a win is worth a lot more, and a bigger winning margin
 * adds a bonus. Beating a harder bot (or a real person) multiplies it, so
 * grinding Rookie can't out-score a Legend win.
 */
export interface PointsInput {
  outcome: "win" | "lose" | "draw";
  goalsFor: number;
  goalsAgainst: number;
  mode: "solo" | "online";
  difficulty?: Difficulty;
}

const BOT_MULTIPLIER: Record<Difficulty, number> = { rookie: 0.6, pro: 1, legend: 1.6 };

export function matchPoints(m: PointsInput): number {
  let base = m.goalsFor * 100;
  if (m.outcome === "win") base += 500 + Math.max(0, m.goalsFor - m.goalsAgainst) * 50;
  if (m.outcome === "draw") base += 150;
  const multiplier = m.mode === "online" ? 1.5 : BOT_MULTIPLIER[m.difficulty ?? "pro"];
  return Math.round((base * multiplier) / 10) * 10;
}

export function outcomeFor(winner: Team | "draw", mine: Team): "win" | "lose" | "draw" {
  if (winner === "draw") return "draw";
  return winner === mine ? "win" : "lose";
}
