/** Player preferences, remembered between visits. Storage may be blocked, so every access is guarded. */
export interface Settings {
  sound: boolean;
  haptics: boolean;
  /** Pick the rod nearest the ball automatically. */
  autoRod: boolean;
  /** Solo difficulty last chosen. */
  difficulty: "rookie" | "pro" | "legend";
  /** Player name used in local development only. */
  name: string;
}

const KEY = "lagos-foosball.settings.v1";

const defaults: Settings = {
  sound: true,
  haptics: true,
  autoRod: true,
  difficulty: "pro",
  name: "",
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* private mode or blocked storage: fall through to defaults */
  }
  return { ...defaults };
}

export const settings: Settings = load();

const listeners: (() => void)[] = [];

export function saveSettings(patch: Partial<Settings> = {}): void {
  Object.assign(settings, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn();
}

export function onSettingsChange(fn: () => void): void {
  listeners.push(fn);
}

/** Small key/value store for stats (best score, wins…), also storage-safe. */
export function readStat<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(`lagos-foosball.${key}`);
    if (raw !== null) return JSON.parse(raw) as T;
  } catch {
    /* ignore */
  }
  return fallback;
}

export function writeStat(key: string, value: unknown): void {
  try {
    localStorage.setItem(`lagos-foosball.${key}`, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}
