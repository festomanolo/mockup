// The shared screenshot library: raw screenshots uploaded once, then routed to the stills, video and store studios.
// It lives for the whole browser session (module singleton), so it survives moving between the studios.
import { dropImage, importImage } from "./engine";

export type LibShot = {
  id: number; url: string; name: string; file: File; w: number; h: number;
  /** The image is already a finished mockup (device frame included), so it is used as it is. */
  framed: boolean;
  /** Routed to the video studio's screen / the store listing. */
  video: boolean; store: boolean;
  /** Set once the user toggles a flag by hand; auto-picking then leaves this screenshot alone. */
  manual: boolean;
  score: number;
  /** Visual fingerprint for duplicate detection. */
  hash: bigint;
  dup: boolean; blank: boolean;
  /** Auto-pick suggestions (shown as badges). */
  suggestVideo: boolean; suggestStore: boolean;
};

type Listener = () => void;
const listeners = new Set<Listener>();
const MAX_SHOTS = 24;

export const library = {
  shots: [] as LibShot[],
  deviceId: "iphone-15-pro",
  finish: 0,
  /** True once the user picked a device in the Guided studio; the store listing then starts with it. */
  deviceChosen: false,
  on(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); },
  emit() { for (const fn of listeners) fn(); },
  get(flag: "video" | "store") { return this.shots.filter((s) => s[flag]); },

  /** Imports files; returns a message per file that could not be used. */
  async add(files: File[], opts: { framed?: boolean } = {}): Promise<string[]> {
    const errors: string[] = [];
    for (const f of files) {
      if (!f.type.startsWith("image/")) { errors.push(`${f.name}: not an image`); continue; }
      if (this.shots.length >= MAX_SHOTS) { errors.push(`Only ${MAX_SHOTS} screenshots fit in the library.`); break; }
      try {
        const r = await importImage(f);
        const a = await analyze(f);
        this.shots.push({
          id: r.id, url: r.url, name: f.name, file: f, w: r.w, h: r.h,
          framed: opts.framed ?? a.transparentEdges, video: false, store: false, manual: false,
          score: a.score, hash: a.hash, dup: false, blank: a.blank, suggestVideo: false, suggestStore: false,
        });
      } catch (e) { errors.push(`${f.name}: ${(e as Error).message}`); }
    }
    this.autoPick();
    return errors;
  },

  remove(id: number) {
    const k = this.shots.findIndex((s) => s.id === id);
    if (k < 0) return;
    const [s] = this.shots.splice(k, 1);
    dropImage(s.id); URL.revokeObjectURL(s.url);
    this.autoPick();
  },

  set(id: number, patch: Partial<Pick<LibShot, "framed" | "video" | "store">>) {
    const s = this.shots.find((x) => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
    if ("video" in patch || "store" in patch) s.manual = true;
    if (patch.framed) s.video = false; // a finished mockup cannot be put on a 3D device screen
    this.emit();
  },

  /**
   * Suggests the strongest, most distinct screenshots: the top 3 raw screens for the video, and every distinct,
   * non-empty screenshot (up to 8, Google Play's limit) for the store. Screenshots the user has toggled by hand are kept.
   */
  autoPick() {
    const seen: bigint[] = [];
    const byScore = [...this.shots].sort((a, b) => b.score - a.score);
    for (const s of byScore) {
      s.dup = seen.some((h) => hamming(h, s.hash) <= 5);
      if (!s.dup) seen.push(s.hash);
    }
    const ok = byScore.filter((s) => !s.dup && !s.blank);
    const videoSet = new Set(ok.filter((s) => !s.framed).slice(0, 3).map((s) => s.id));
    const storeSet = new Set(ok.slice(0, 8).map((s) => s.id));
    for (const s of this.shots) {
      s.suggestVideo = videoSet.has(s.id);
      s.suggestStore = storeSet.has(s.id);
      if (!s.manual) { s.video = s.suggestVideo; s.store = s.suggestStore; }
    }
    this.emit();
  },

  /** Re-applies the suggestions to every screenshot, discarding manual choices. */
  resetPicks() {
    for (const s of this.shots) s.manual = false;
    this.autoPick();
  },
};

// ---------- analysis ----------
function hamming(a: bigint, b: bigint) {
  let x = a ^ b, n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

async function analyze(file: File): Promise<{ score: number; hash: bigint; blank: boolean; transparentEdges: boolean }> {
  const bmp = await createImageBitmap(file);
  const S = 48;
  const c = document.createElement("canvas");
  c.width = S; c.height = S;
  const x = c.getContext("2d", { willReadFrequently: true })!;
  x.drawImage(bmp, 0, 0, S, S);
  const d = x.getImageData(0, 0, S, S).data;
  // a screenshot with transparent corners/edges is almost certainly a finished mockup
  let edgeTransparent = 0, edgeCount = 0;
  for (let i = 0; i < S; i++) for (const [px, py] of [[i, 0], [i, S - 1], [0, i], [S - 1, i]]) { edgeCount++; if (d[(py * S + px) * 4 + 3] < 40) edgeTransparent++; }
  const lum = new Float32Array(S * S);
  const colors = new Set<number>();
  let sum = 0;
  for (let i = 0; i < S * S; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    sum += lum[i];
    colors.add(((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4));
  }
  const mean = sum / (S * S);
  let v = 0, edge = 0;
  for (let i = 0; i < S * S; i++) v += (lum[i] - mean) ** 2;
  for (let y = 0; y < S; y++) for (let xx = 1; xx < S; xx++) edge += Math.abs(lum[y * S + xx] - lum[y * S + xx - 1]);
  const std = Math.sqrt(v / (S * S));
  edge /= S * (S - 1);
  // 9×8 difference hash
  const h = document.createElement("canvas"); h.width = 9; h.height = 8;
  const hx = h.getContext("2d", { willReadFrequently: true })!;
  hx.drawImage(bmp, 0, 0, 9, 8);
  const hd = hx.getImageData(0, 0, 9, 8).data;
  let hash = 0n;
  for (let y = 0; y < 8; y++) for (let xx = 0; xx < 8; xx++) {
    const a = hd[(y * 9 + xx) * 4] + hd[(y * 9 + xx) * 4 + 1] + hd[(y * 9 + xx) * 4 + 2];
    const b = hd[(y * 9 + xx + 1) * 4] + hd[(y * 9 + xx + 1) * 4 + 1] + hd[(y * 9 + xx + 1) * 4 + 2];
    hash = (hash << 1n) | (a > b ? 1n : 0n);
  }
  const res = Math.min(1, (bmp.width * bmp.height) / (1170 * 2532));
  const ratio = bmp.height / bmp.width;
  const plausible = ratio > 1.4 && ratio < 2.4 ? 1 : 0.5; // phone-like proportions
  bmp.close();
  const score = 0.4 * Math.min(std / 60, 1) + 0.3 * Math.min(edge / 18, 1) + 0.15 * Math.min(colors.size / 60, 1) + 0.1 * res + 0.05 * plausible;
  return { score, hash, blank: std < 8 && colors.size < 8, transparentEdges: edgeTransparent / edgeCount > 0.5 };
}
