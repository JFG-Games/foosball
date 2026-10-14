import "./style.css";
import { Game } from "./game/game";

/**
 * Entry point. The Game owns everything else: the renderer, menus, the
 * current match and the connection to the Lagos Life platform.
 */
const root = document.getElementById("app");
if (!root) throw new Error("#app is missing from index.html");

void new Game(root).boot();
