import { sfx } from "../audio";

/**
 * A first-time walkthrough: a dimmed screen with a spotlight on one thing at a
 * time, a bouncing pointer aimed at it, and a short card saying what it does.
 * The player presses NEXT to go on, or SKIP to leave.
 *
 * Targets are functions, not elements, because some of them live in the 3D
 * scene (your goal, the ball, your rods) and have to be projected to the
 * screen at the moment each step is shown.
 */
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface TutorialStep {
  title: string;
  body: string;
  /** Where to point, in viewport pixels; null for a full-screen card. */
  target: () => Rect | null;
}

const PAD = 10;

export class Tutorial {
  private layer: HTMLElement | null = null;

  constructor(private readonly root: HTMLElement) {}

  get active(): boolean {
    return this.layer !== null;
  }

  /** Run the steps. `done(true)` when finished, `done(false)` when skipped. */
  run(steps: TutorialStep[], done: (completed: boolean) => void): void {
    this.close();
    let index = 0;

    const layer = document.createElement("div");
    layer.className = "tut";
    layer.innerHTML = `
      <div class="tut-spot"></div>
      <div class="tut-hand" aria-hidden="true"></div>
      <div class="tut-card">
        <div class="tut-step"></div>
        <h3></h3>
        <p></p>
        <div class="tut-dots"></div>
        <div class="tut-btns">
          <button class="btn ghost tiny" data-tut="skip">SKIP</button>
          <button class="btn green" data-tut="next">NEXT</button>
        </div>
      </div>`;
    this.root.appendChild(layer);
    this.layer = layer;

    const spot = layer.querySelector<HTMLElement>(".tut-spot")!;
    const hand = layer.querySelector<HTMLElement>(".tut-hand")!;
    const card = layer.querySelector<HTMLElement>(".tut-card")!;
    const stepEl = layer.querySelector<HTMLElement>(".tut-step")!;
    const title = card.querySelector<HTMLElement>("h3")!;
    const body = card.querySelector<HTMLElement>("p")!;
    const dots = card.querySelector<HTMLElement>(".tut-dots")!;
    const next = card.querySelector<HTMLElement>('[data-tut="next"]')!;

    const show = (): void => {
      const step = steps[index];
      const last = index === steps.length - 1;
      stepEl.textContent = `${index + 1} / ${steps.length}`;
      title.textContent = step.title;
      body.textContent = step.body;
      next.textContent = last ? "LET'S PLAY!" : "NEXT";
      dots.innerHTML = steps.map((_, i) => `<i class="${i === index ? "on" : ""}"></i>`).join("");

      // Restart the card's entrance animation.
      card.classList.remove("in");
      void card.offsetWidth;
      card.classList.add("in");

      const target = step.target();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      if (!target) {
        spot.style.opacity = "0";
        hand.style.opacity = "0";
        layer.classList.add("flat");
        card.style.top = `${Math.max(40, vh / 2 - card.offsetHeight / 2)}px`;
        return;
      }
      layer.classList.remove("flat");

      const x = Math.max(4, target.left - PAD);
      const y = Math.max(4, target.top - PAD);
      const w = Math.min(vw - x - 4, target.width + PAD * 2);
      const h = Math.min(vh - y - 4, target.height + PAD * 2);
      spot.style.cssText = `opacity:1;left:${x}px;top:${y}px;width:${w}px;height:${h}px`;

      // Card goes on whichever side of the target has more room; the pointer
      // sits between them and aims at the target.
      const centreY = y + h / 2;
      const cardH = card.offsetHeight || 190;
      const below = centreY < vh / 2;
      let cardTop = below ? y + h + 64 : y - 64 - cardH;
      cardTop = Math.min(Math.max(cardTop, 70), vh - cardH - 16);
      card.style.top = `${cardTop}px`;

      hand.textContent = below ? "👆" : "👇";
      hand.style.opacity = "1";
      hand.style.left = `${Math.min(Math.max(x + w / 2, 24), vw - 24)}px`;
      hand.style.top = below ? `${y + h + 4}px` : `${y - 56}px`;
    };

    const finish = (completed: boolean): void => {
      this.close();
      done(completed);
    };

    layer.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-tut]");
      if (!button) return;
      sfx.unlock();
      sfx.click();
      if (button.dataset.tut === "skip") return finish(false);
      if (index >= steps.length - 1) return finish(true);
      index++;
      show();
    });

    const onResize = (): void => show();
    window.addEventListener("resize", onResize);
    (layer as HTMLElement & { _off?: () => void })._off = () => window.removeEventListener("resize", onResize);

    show();
    // The first measurement happens before fonts settle; re-place once they have.
    requestAnimationFrame(show);
  }

  close(): void {
    const layer = this.layer as (HTMLElement & { _off?: () => void }) | null;
    layer?._off?.();
    layer?.remove();
    this.layer = null;
  }
}
