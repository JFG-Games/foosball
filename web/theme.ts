import type { Team } from "@shared/constants";

/** Team colours: the left side wears the model's native blue, the right is recoloured red. */
export const TEAM_HEX: Record<Team, number> = {
  left: 0x2a6bff,
  right: 0xff3b3b,
};

export const TEAM_CSS: Record<Team, string> = {
  left: "#2a6bff",
  right: "#ff3b3b",
};

export const TEAM_NAME: Record<Team, string> = {
  left: "BLUE",
  right: "RED",
};

export const other = (team: Team): Team => (team === "left" ? "right" : "left");
