import { sfx } from "../audio";

/**
 * Comic-book words. "GOAL!", "WHAM!", "SAVED!" bouncing onto the screen.
 *
 * Each word is its own element so they can arrive all at once or one by one,
 * every word overshooting and settling like a cartoon. A `shock` entrance
 * slams in from huge instead. An optional starburst sits behind the text.
 *
 * Animation uses the Web Animations API, so it runs on the compositor and
 * costs nothing per frame in JavaScript.
 */
export interface PopOptions {
  /** Words arrive together, or one after another. Default: stagger when there is more than one word. */
  mode?: "together" | "stagger";
  color?: string;
  stroke?: string;
  /** Relative size, 1 = normal. */
  size?: number;
  /** Centre of the text, as a fraction of the layer (0..1). */
  x?: number;
  y?: number;
  /** Time on screen once fully in (ms). */
  hold?: number;
  /** Rotation in degrees; random in ±5 when omitted. */
  tilt?: number;
  /** A starburst behind the text, in this colour. */
  burst?: string;
  /** Slam in from huge instead of bouncing up from nothing. */
  shock?: boolean;
  /** Delay between words when staggering (ms). */
  gap?: number;
  /** How it leaves. */
  exit?: "pop" | "fall" | "rise";
  /** Make the pop sound per word (default true). */
  sound?: boolean;
}

const MAX_ALIVE = 7;

/** A 14-point comic starburst as an SVG path. */
function starburst(colour: string): string {
  const points: string[] = [];
  const spikes = 14;
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? 100 : 66 + ((i * 7) % 5) * 2;
    const a = (Math.PI * i) / spikes - Math.PI / 2;
    points.push(`${(100 + Math.cos(a) * r).toFixed(1)},${(100 + Math.sin(a) * r).toFixed(1)}`);
  }
  const id = `dots${Math.floor(Math.random() * 1e6)}`;
  return `<svg viewBox="0 0 200 200" aria-hidden="true">
    <defs>
      <pattern id="${id}" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(30)">
        <circle cx="4.5" cy="4.5" r="1.9" fill="rgba(0,0,0,0.18)"/>
      </pattern>
    </defs>
    <polygon points="${points.join(" ")}" fill="#000" transform="translate(5 7)"/>
    <polygon points="${points.join(" ")}" fill="${colour}" stroke="#000" stroke-width="5" stroke-linejoin="round"/>
    <polygon points="${points.join(" ")}" fill="url(#${id})"/>
  </svg>`;
}

export class Words {
  private readonly alive: HTMLElement[] = [];

  constructor(private readonly layer: HTMLElement) {}

  /** Pop `text` on screen. Returns a promise that resolves when it has gone. */
  pop(text: string, opts: PopOptions = {}): Promise<void> {
    const words = text.split(/\s+/).filter(Boolean);
    const stagger = (opts.mode ?? (words.length > 1 ? "stagger" : "together")) === "stagger";
    const gap = opts.gap ?? 150;
    const hold = opts.hold ?? 900;
    const tilt = opts.tilt ?? (Math.random() * 10 - 5);

    const root = document.createElement("div");
    root.className = "pop";
    root.style.left = `${(opts.x ?? 0.5) * 100}%`;
    root.style.top = `${(opts.y ?? 0.4) * 100}%`;
    root.style.setProperty("--size", String(opts.size ?? 1));
    root.style.setProperty("--fill", opts.color ?? "#ffd23f");
    root.style.setProperty("--stroke", opts.stroke ?? "#14112b");
    root.style.transform = `translate(-50%, -50%) rotate(${tilt}deg)`;

    let burstEl: HTMLElement | null = null;
    if (opts.burst) {
      burstEl = document.createElement("div");
      burstEl.className = "pop-burst";
      burstEl.innerHTML = starburst(opts.burst);
      root.appendChild(burstEl);
    }

    const row = document.createElement("div");
    row.className = "pop-row";
    const spans = words.map((word) => {
      const span = document.createElement("span");
      span.className = "pop-word";
      span.textContent = word;
      span.style.opacity = "0";
      row.appendChild(span);
      return span;
    });
    root.appendChild(row);

    this.layer.appendChild(root);
    this.alive.push(root);
    while (this.alive.length > MAX_ALIVE) this.alive.shift()?.remove();

    // Entrance.
    const shock = opts.shock ?? false;
    const inKeys: Keyframe[] = shock
      ? [
          { transform: "scale(3.4) rotate(-14deg)", opacity: 0, offset: 0 },
          { transform: "scale(0.78) rotate(4deg)", opacity: 1, offset: 0.4 },
          { transform: "scale(1.14) rotate(-2deg)", offset: 0.62 },
          { transform: "scale(0.96) rotate(1deg)", offset: 0.8 },
          { transform: "scale(1) rotate(0deg)", opacity: 1, offset: 1 },
        ]
      : [
          { transform: "translateY(40px) scale(0.1, 0.1) rotate(-14deg)", opacity: 0, offset: 0 },
          { transform: "translateY(-14px) scale(0.85, 1.5) rotate(5deg)", opacity: 1, offset: 0.34 },
          { transform: "translateY(4px) scale(1.4, 0.8) rotate(-4deg)", offset: 0.55 },
          { transform: "translateY(-3px) scale(0.92, 1.1) rotate(2deg)", offset: 0.75 },
          { transform: "translateY(0) scale(1) rotate(0deg)", opacity: 1, offset: 1 },
        ];
    const inMs = shock ? 360 : 560;

    let finish!: () => void;
    const done = new Promise<void>((resolve) => (finish = resolve));

    if (burstEl) {
      burstEl.animate(
        [
          { transform: "scale(0) rotate(-30deg)", opacity: 0 },
          { transform: "scale(1.2) rotate(6deg)", opacity: 1, offset: 0.5 },
          { transform: "scale(1) rotate(0deg)", opacity: 1 },
        ],
        { duration: 420, easing: "cubic-bezier(.2,.9,.3,1.2)", fill: "forwards" },
      );
    }

    spans.forEach((span, i) => {
      const delay = stagger ? i * gap : 0;
      span.animate(inKeys, { duration: inMs, delay, easing: "ease-out", fill: "both" });
      span.style.opacity = "1";
      if (opts.sound !== false) window.setTimeout(() => sfx.pop(stagger ? i : 0), delay);
    });

    const enterTotal = (stagger ? (spans.length - 1) * gap : 0) + inMs;

    // Exit.
    window.setTimeout(() => {
      const exit = opts.exit ?? "pop";
      const outKeys: Keyframe[] =
        exit === "fall"
          ? [{ transform: "translateY(0) rotate(0deg)", opacity: 1 }, { transform: "translateY(120px) rotate(14deg)", opacity: 0 }]
          : exit === "rise"
            ? [{ transform: "translateY(0)", opacity: 1 }, { transform: "translateY(-90px) scale(1.1)", opacity: 0 }]
            : [{ transform: "scale(1)", opacity: 1 }, { transform: "scale(1.5)", opacity: 0 }];
      const anim = root.animate(outKeys, { duration: 260, easing: "ease-in", fill: "forwards" });
      anim.onfinish = () => {
        root.remove();
        const at = this.alive.indexOf(root);
        if (at !== -1) this.alive.splice(at, 1);
        finish();
      };
    }, enterTotal + hold);

    return done;
  }

  /** Small floating word anchored at a screen position (px, relative to the layer). */
  popAt(xPx: number, yPx: number, text: string, opts: PopOptions = {}): Promise<void> {
    const rect = this.layer.getBoundingClientRect();
    return this.pop(text, {
      size: 0.45,
      hold: 260,
      exit: "rise",
      sound: false,
      ...opts,
      x: xPx / Math.max(1, rect.width),
      y: yPx / Math.max(1, rect.height),
    });
  }

  clear(): void {
    for (const el of this.alive.splice(0)) el.remove();
  }
}
