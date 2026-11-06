// Draws store slides with Canvas 2D. The device itself comes from the existing Rust/WASM renderer, so screenshots
// sit in the same accurate frames as the stills page. A slide is drawn from the whole panorama (its neighbours are
// painted too, then cropped), which is what lets backgrounds and devices flow across slide edges.
import { importImage, render } from "../engine";
import { FEATURE, FONTS, paletteColors, type Listing } from "./model";
import { layout, type TextPlace } from "./templates";

export type Shot = { id: number; url: string; name: string };
export type Assets = { shots: Shot[]; placeholders: number[] };

// ---------- device bitmaps ----------
const bitmaps = new Map<string, Promise<ImageBitmap>>();
const aspects = new Map<string, Promise<number>>();
const BUCKETS = [320, 640, 1000, 1600, 2400, 3200, 4096];

async function deviceBitmap(deviceId: string, finish: number, imageId: number | null, need: number): Promise<ImageBitmap> {
  const side = BUCKETS.find((b) => b >= need) ?? 4096;
  const key = `${deviceId}|${finish}|${imageId}|${side}`;
  let p = bitmaps.get(key);
  if (!p) {
    p = render({ deviceId, finish, orientation: "portrait", fit: "cover", maxSide: side, native: true, imageId }).then((r) => createImageBitmap(r.data));
    bitmaps.set(key, p);
    p.catch(() => bitmaps.delete(key));
    if (bitmaps.size > 40) {
      const old = bitmaps.keys().next().value!;
      bitmaps.get(old)?.then((b) => b.close()).catch(() => {});
      bitmaps.delete(old);
    }
  }
  return p;
}

async function deviceAspect(deviceId: string, finish: number): Promise<number> {
  const key = `${deviceId}|${finish}`;
  let p = aspects.get(key);
  if (!p) {
    p = render({ deviceId, finish, orientation: "portrait", fit: "cover", maxSide: 200, native: false, imageId: null }).then((r) => r.width / r.height);
    aspects.set(key, p);
  }
  return p;
}

// ---------- placeholder screens (so the design looks right before real screenshots are added) ----------
export async function makePlaceholders(): Promise<number[]> {
  const ids: number[] = [];
  const W = 1170, H = 2532;
  const accents = ["#4f7cff", "#ff6b6b", "#22c28b", "#a86bff"];
  for (let v = 0; v < 4; v++) {
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d")!;
    x.fillStyle = "#f4f6fa"; x.fillRect(0, 0, W, H);
    x.fillStyle = accents[v];
    x.fillRect(0, 0, W, 520);
    x.fillStyle = "rgba(255,255,255,.92)";
    x.font = "700 78px system-ui, sans-serif"; x.fillText(["Today", "Explore", "Activity", "Profile"][v], 80, 330);
    x.fillStyle = "rgba(255,255,255,.55)"; x.font = "500 44px system-ui, sans-serif"; x.fillText("A calmer way to get things done", 80, 410);
    for (let k = 0; k < 5; k++) {
      const y = 600 + k * 330;
      x.fillStyle = "#fff"; x.beginPath(); x.roundRect(60, y, W - 120, 280, 36); x.fill();
      x.fillStyle = accents[(v + k) % 4]; x.beginPath(); x.roundRect(100, y + 50, 180, 180, 40); x.fill();
      x.fillStyle = "#1b2230"; x.beginPath(); x.roundRect(330, y + 62, 460, 36, 18); x.fill();
      x.fillStyle = "#c9d0dc"; x.beginPath(); x.roundRect(330, y + 130, 650 - k * 40, 28, 14); x.fill();
      x.beginPath(); x.roundRect(330, y + 182, 380, 28, 14); x.fill();
    }
    x.fillStyle = "#fff"; x.fillRect(0, H - 220, W, 220);
    for (let k = 0; k < 4; k++) { x.fillStyle = k === v ? accents[v] : "#c9d0dc"; x.beginPath(); x.arc(150 + k * 290, H - 110, 34, 0, Math.PI * 2); x.fill(); }
    const blob = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/png"));
    if (!blob) continue;
    ids.push((await importImage(new File([blob], `sample-${v}.png`, { type: "image/png" }))).id);
  }
  return ids;
}

// ---------- colour helpers ----------
const rgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
const lum = ([r, g, b]: number[]) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
const mix = (a: string, b: string, t: number) => { const x = rgb(a), y = rgb(b); return x.map((v, i) => v + (y[i] - v) * t) as [number, number, number]; };

/** Approximate background colour at the slide's centre, used to choose readable text. */
function bgAt(L: Listing, i: number, n: number): [number, number, number] {
  const cs = paletteColors(L);
  if (!L.seamless) return mix(cs[i % cs.length], cs[(i + 1) % cs.length], 0.5);
  const t = n === 1 ? 0.5 : (i + 0.5) / n;
  const pos = t * (cs.length - 1), k = Math.min(cs.length - 2, Math.floor(pos));
  return mix(cs[k], cs[k + 1], pos - k);
}
function inkFor(L: Listing, i: number, n: number): { fg: string; soft: string; dark: boolean } {
  const dark = L.textColor === "auto" ? lum(bgAt(L, i, n)) > 0.62 : L.textColor === "dark";
  return dark ? { fg: "#0d1117", soft: "rgba(13,17,23,.72)", dark } : { fg: "#ffffff", soft: "rgba(255,255,255,.8)", dark };
}
const frac = (v: number) => v - Math.floor(v);
const noise = (j: number, k: number) => frac(Math.sin(j * 127.1 + k * 311.7) * 43758.5453);

// ---------- drawing pieces ----------
type C = CanvasRenderingContext2D;

function drawBackground(c: C, L: Listing, i: number, n: number, W: number, H: number) {
  const cs = paletteColors(L);
  if (L.seamless) {
    const g = c.createLinearGradient(-i * W, 0, (n - i) * W, 0);
    cs.forEach((col, k) => g.addColorStop(cs.length === 1 ? 0 : k / (cs.length - 1), col));
    c.fillStyle = g;
  } else {
    const g = c.createLinearGradient(0, 0, W * 0.4, H);
    g.addColorStop(0, cs[i % cs.length]);
    g.addColorStop(1, cs[(i + 1) % cs.length]);
    c.fillStyle = g;
  }
  c.fillRect(0, 0, W, H);
  // soft light blobs in panorama space, so neighbouring slides share them
  for (let j = i - 1; j <= i + 1; j++) {
    if (j < 0 || j >= n) continue;
    for (let k = 0; k < 2; k++) {
      const cx = (j - i) * W + W * (0.15 + 0.7 * noise(j, k)), cy = H * (0.15 + 0.7 * noise(j + 9, k + 3)), r = W * (0.55 + 0.35 * noise(j + 4, k));
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, k ? "rgba(255,255,255,.13)" : "rgba(0,0,0,.14)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, W, H);
    }
  }
  const sheen = c.createLinearGradient(0, 0, 0, H);
  sheen.addColorStop(0, "rgba(255,255,255,.10)"); sheen.addColorStop(0.5, "rgba(255,255,255,0)"); sheen.addColorStop(1, "rgba(0,0,0,.16)");
  c.fillStyle = sheen;
  c.fillRect(0, 0, W, H);
}

function drawRings(c: C, cx: number, cy: number, W: number, dark: boolean) {
  c.save();
  c.strokeStyle = dark ? "rgba(0,0,0,.10)" : "rgba(255,255,255,.16)";
  c.lineWidth = Math.max(1, W * 0.006);
  for (const r of [0.42, 0.66, 0.9, 1.15]) { c.beginPath(); c.arc(cx, cy, W * r, 0, Math.PI * 2); c.stroke(); }
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, W * 0.42);
  g.addColorStop(0, dark ? "rgba(0,0,0,.06)" : "rgba(255,255,255,.18)"); g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g; c.beginPath(); c.arc(cx, cy, W * 0.42, 0, Math.PI * 2); c.fill();
  c.restore();
}

function drawDevice(c: C, bmp: ImageBitmap, x: number, top: number, w: number, rot: number, W: number, dark: boolean) {
  const h = (w * bmp.height) / bmp.width;
  const cx = x, cy = top + h / 2;
  // glow
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, w * 0.95);
  g.addColorStop(0, dark ? "rgba(255,255,255,.35)" : "rgba(255,255,255,.2)"); g.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = g; c.fillRect(cx - w, cy - h, w * 2, h * 2);
  c.save();
  c.translate(cx, cy);
  c.rotate(rot);
  c.shadowColor = dark ? "rgba(20,25,40,.38)" : "rgba(0,0,0,.45)";
  c.shadowBlur = W * 0.07;
  c.shadowOffsetY = W * 0.03;
  c.imageSmoothingQuality = "high";
  c.drawImage(bmp, -w / 2, -h / 2, w, h);
  c.restore();
}

function wrap(c: C, text: string, maxW: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (const wd of words) {
    const t = cur ? `${cur} ${wd}` : wd;
    if (c.measureText(t).width <= maxW || !cur) cur = t; else { lines.push(cur); cur = wd; }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Wraps like `wrap` but narrows the measure while the line count stays the same, so the last line is never a lone word. */
function balanced(c: C, text: string, maxW: number): string[] {
  const base = wrap(c, text, maxW);
  if (base.length < 2) return base;
function drawText(c: C, L: Listing, p: TextPlace, headline: string, sub: string, W: number, ink: { fg: string; soft: string }) {
  if (!headline.trim() && !sub.trim()) return;
  const f = FONTS[L.font];
  c.save();
  c.textBaseline = "top";
  c.textAlign = p.align;
  let size = W * 0.088 * p.scale;
  let lines: string[] = [];
  const set = (s: number) => { c.font = `${f.weight} ${s}px ${f.css}`; };
  for (let k = 0; k < 24; k++) {
    set(size);
    lines = wrap(c, headline, p.w);
    if (lines.length <= p.maxLines && lines.every((l) => c.measureText(l).width <= p.w * 1.001)) break;
    size *= 0.93;
  }
  (c as any).letterSpacing = `${-size * 0.015}px`;
  c.fillStyle = ink.fg;
  const lh = size * 1.08;
  let y = p.y;
  for (const l of lines) { c.fillText(l, p.x, y); y += lh; }
  if (sub.trim()) {
    const ss = Math.min(size * 0.42, W * 0.04 * p.scale);
    (c as any).letterSpacing = "0px";
    c.font = `500 ${ss}px ${f.css}`;
    c.fillStyle = ink.soft;
    y += size * 0.16;
    for (const l of wrap(c, sub, p.w * 0.92).slice(0, 3)) { c.fillText(l, p.x, y); y += ss * 1.3; }
  }
  c.restore();
}

// ---------- public: slide ----------
const pickShot = (A: Assets, shot: number | null, j: number, off: number): number | null => {
  if (A.shots.length) return A.shots[((shot ?? j) + off) % A.shots.length].id;
  if (A.placeholders.length) return A.placeholders[((shot ?? j) + off) % A.placeholders.length];
  return null;
};

export async function renderSlide(canvas: HTMLCanvasElement, L: Listing, A: Assets, i: number, W: number, H: number, kind: "phone" | "tablet") {
  const n = L.slides.length;
  const deviceId = kind === "tablet" ? L.tabletId : L.deviceId;
  const a = await deviceAspect(deviceId, L.finish);
  const js = [i - 1, i, i + 1].filter((j) => j >= 0 && j < n);
  type Job = { j: number; place: ReturnType<typeof layout>["devices"][number]; bmp: Promise<ImageBitmap> };
  const lays = js.map((j) => ({ j, lay: layout(L.slides[j].template, W, H, a) }));
  const jobs: Job[] = [];
  for (const { j, lay } of lays) {
    for (const place of lay.devices) {
      const off = (j - i) * W + place.x;
      if (Math.abs(off - W / 2) > W / 2 + place.w * 0.85) continue; // not visible on this slide
      const need = Math.ceil(place.w / a);
      jobs.push({ j, place, bmp: deviceBitmap(deviceId, L.finish, pickShot(A, L.slides[j].shot, j, place.shotOffset), need) });
    }
  }
  const bmps = await Promise.all(jobs.map((x) => x.bmp));
  if (canvas.width !== Math.round(W)) canvas.width = Math.round(W);
  if (canvas.height !== Math.round(H)) canvas.height = Math.round(H);
  const c = canvas.getContext("2d")!;
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, W, H);
  drawBackground(c, L, i, n, W, H);
  for (const { j, lay } of lays) {
    if (lay.rings) { c.save(); c.translate((j - i) * W, 0); drawRings(c, W / 2, H * 0.58, W, inkFor(L, j, n).dark); c.restore(); }
  }
  jobs.forEach((job, k) => {
    c.save();
    c.translate((job.j - i) * W, 0);
    drawDevice(c, bmps[k], job.place.x, job.place.top, job.place.w, job.place.rot, W, inkFor(L, job.j, n).dark);
    c.restore();
  });
  // text last, only the current slide's own text, so nothing is cut at an edge
  const s = L.slides[i];
  const lay = lays.find((x) => x.j === i)!.lay;
  drawText(c, L, lay.text, s.headline, s.sub, W, inkFor(L, i, n));
}

// ---------- public: Google Play feature graphic (1024×500) ----------
export async function renderFeature(canvas: HTMLCanvasElement, L: Listing, A: Assets, W = FEATURE.w, H = FEATURE.h) {
  canvas.width = W; canvas.height = H;
  const c = canvas.getContext("2d")!;
  const cs = paletteColors(L);
  const g = c.createLinearGradient(0, 0, W, H * 0.6);
  cs.forEach((col, k) => g.addColorStop(cs.length === 1 ? 0 : k / (cs.length - 1), col));
  c.fillStyle = g; c.fillRect(0, 0, W, H);
  const r = c.createRadialGradient(W * 0.78, H * 0.45, 0, W * 0.78, H * 0.45, H * 1.1);
  r.addColorStop(0, "rgba(255,255,255,.22)"); r.addColorStop(1, "rgba(255,255,255,0)");
  c.fillStyle = r; c.fillRect(0, 0, W, H);
  const ink = inkFor(L, 0, 1);
  const f = FONTS[L.font];
  const s0 = L.slides[0];
  c.textBaseline = "top"; c.textAlign = "left";
  c.fillStyle = ink.soft; c.font = `700 ${H * 0.07}px ${f.css}`;
  (c as any).letterSpacing = "1px";
  c.fillText((L.app.name || "Your app").toUpperCase(), W * 0.06, H * 0.14);
  (c as any).letterSpacing = "0px";
  const maxW = W * 0.5;
  let size = H * 0.17, lines: string[] = [];
  for (let k = 0; k < 20; k++) {
    c.font = `${f.weight} ${size}px ${f.css}`;
    lines = wrap(c, s0.headline, maxW);
    if (lines.length <= 3) break;
    size *= 0.93;
  }
  c.fillStyle = ink.fg;
  let y = H * 0.27;
  for (const l of lines) { c.fillText(l, W * 0.06, y); y += size * 1.08; }
  if (s0.sub) {
    const ss = H * 0.062;
    c.font = `500 ${ss}px ${f.css}`; c.fillStyle = ink.soft; y += size * 0.12;
    for (const l of wrap(c, s0.sub, maxW).slice(0, 2)) { c.fillText(l, W * 0.06, y); y += ss * 1.3; }
  }
  const a = await deviceAspect(L.deviceId, L.finish);
  const dw = H * 0.78 * a;
  const places = [{ x: W * 0.68, top: H * 0.16, rot: -0.09, off: 1 }, { x: W * 0.85, top: H * 0.1, rot: 0.07, off: 0 }];
  for (const p of places) {
    const bmp = await deviceBitmap(L.deviceId, L.finish, pickShot(A, L.slides[0].shot, 0, p.off), Math.ceil(dw / a));
    drawDevice(c, bmp, p.x, p.top, dw, p.rot, W * 0.5, ink.dark);
  }
}

export const toBlob = (c: HTMLCanvasElement, type: "image/png" | "image/jpeg", q = 0.95) =>
  new Promise<Blob>((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("The browser could not encode an image (out of memory?)."))), type, q));
