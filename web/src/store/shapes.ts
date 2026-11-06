// Decorative background shapes. Everything is drawn in "panorama space": slide j occupies x in [j*W, (j+1)*W], and
// the caller translates the canvas so the slide being exported sits at the origin. Continuous styles (waves, ribbons,
// flow lines, grids…) are functions of the global x, and scattered styles are seeded per slide, so a shape that
// crosses a slide edge is drawn identically by both neighbours and lines up exactly in the exported images.
import type { ShapeLayer } from "./model";

type C = CanvasRenderingContext2D;
export type Env = {
  c: C; W: number; H: number;
  /** Slides to generate scattered shapes for. */
  j0: number; j1: number;
  /** Horizontal range (panorama px) that is actually visible, for continuous styles. */
  x0: number; x1: number;
  seed: number; scale: number; alpha: number;
  /** Fill/stroke colour at a given alpha. */
  col: (a: number) => string;
};

const rnd = (s: number, j: number, k: number) => {
  let t = Math.imul(s | 0, 374761393) ^ Math.imul(j | 0, 668265263) ^ Math.imul(k | 0, 2246822519);
  t = Math.imul(t ^ (t >>> 13), 1274126177);
  return ((t ^ (t >>> 16)) >>> 0) / 4294967296;
};
const TAU = Math.PI * 2;

function blobPath(c: C, cx: number, cy: number, r: number, s: number, j: number, k: number) {
  const n = 7, pts: [number, number][] = [];
  for (let p = 0; p < n; p++) {
    const a = (p / n) * TAU, rr = r * (0.72 + 0.56 * rnd(s, j * 50 + k, p));
    pts.push([cx + Math.cos(a) * rr, cy + Math.sin(a) * rr]);
  }
  c.beginPath();
  c.moveTo((pts[0][0] + pts[n - 1][0]) / 2, (pts[0][1] + pts[n - 1][1]) / 2);
  for (let p = 0; p < n; p++) {
    const q = pts[(p + 1) % n];
    c.quadraticCurveTo(pts[p][0], pts[p][1], (pts[p][0] + q[0]) / 2, (pts[p][1] + q[1]) / 2);
  }
  c.closePath();
}

const each = (e: Env, per: number, fn: (j: number, k: number, r: (n: number) => number) => void) => {
  for (let j = e.j0; j <= e.j1; j++) for (let k = 0; k < per; k++) fn(j, k, (n) => rnd(e.seed, j * 97 + k, n));
};
const sweep = (e: Env, step: number, fn: (x: number) => void) => {
  for (let x = Math.floor(e.x0 / step) * step; x <= e.x1 + step; x += step) fn(x);
};

const STYLES: Record<string, (e: Env) => void> = {
  blobs(e) {
    const { c, W, H } = e;
    each(e, 4, (j, k, r) => {
      const cx = (j + r(1)) * W, cy = r(2) * H, rad = W * (0.18 + 0.32 * r(3)) * e.scale;
      const g = c.createRadialGradient(cx, cy, 0, cx, cy, rad * 1.1);
      g.addColorStop(0, e.col(e.alpha * 0.55)); g.addColorStop(1, e.col(e.alpha * 0.08));
      c.fillStyle = g; blobPath(c, cx, cy, rad, e.seed, j, k); c.fill();
    });
  },
  bubbles(e) {
    const { c, W, H } = e;
    each(e, 14, (j, k, r) => {
      const rad = W * (0.015 + 0.09 * r(3) * r(3)) * e.scale, cx = (j + r(1)) * W, cy = r(2) * H;
      c.beginPath(); c.arc(cx, cy, rad, 0, TAU);
      if (k % 2) { c.lineWidth = W * 0.004; c.strokeStyle = e.col(e.alpha * 0.6); c.stroke(); } else { c.fillStyle = e.col(e.alpha * 0.3); c.fill(); }
    });
  },
  rings(e) {
    const { c, W, H } = e;
    c.lineWidth = W * 0.004;
    each(e, 2, (j, k, r) => {
      const cx = (j + r(1)) * W, cy = r(2) * H;
      for (let q = 1; q <= 5; q++) { c.beginPath(); c.arc(cx, cy, W * 0.06 * q * e.scale * (0.8 + k * 0.5), 0, TAU); c.strokeStyle = e.col(e.alpha * (0.6 - q * 0.08)); c.stroke(); }
    });
  },
  waves(e) {
    const { c, W, H } = e;
    for (let b = 0; b < 4; b++) {
      c.beginPath(); c.moveTo(e.x0 - W, H);
      sweep(e, W / 30, (x) => c.lineTo(x, H * (0.5 + 0.1 * b) + H * 0.05 * Math.sin((x / W) * (1.1 + 0.3 * b) * 2 / e.scale + b * 1.7 + e.seed) + H * 0.025 * Math.sin((x / W) * 5.3 + b)));
      c.lineTo(e.x1 + W, H); c.closePath(); c.fillStyle = e.col(e.alpha * (0.1 + 0.05 * b)); c.fill();
    }
  },
  dunes(e) {
    const { c, W, H } = e;
    for (let l = 0; l < 3; l++) {
      c.beginPath(); c.moveTo(e.x0 - W, H);
      sweep(e, W / 30, (x) => c.lineTo(x, H * (0.8 + 0.05 * l) - H * 0.06 * Math.sin((x / W) * 2.2 / e.scale + l * 2 + e.seed) - H * 0.03 * Math.sin((x / W) * 5 + l)));
      c.lineTo(e.x1 + W, H); c.closePath(); c.fillStyle = e.col(e.alpha * (0.18 + 0.14 * l)); c.fill();
    }
  },
  diagonals(e) {
    const { c, W, H } = e, step = W * 0.09 * e.scale;
    c.fillStyle = e.col(e.alpha * 0.4);
    sweep(e, step, (x) => { c.beginPath(); c.moveTo(x, 0); c.lineTo(x + step * 0.4, 0); c.lineTo(x + step * 0.4 - H * 0.6, H); c.lineTo(x - H * 0.6, H); c.closePath(); c.fill(); });
  },
  dots(e) {
    const { c, W, H } = e, step = W * 0.055 * e.scale;
    sweep(e, step, (x) => {
      for (let y = step / 2; y < H; y += step) {
        const v = (Math.sin((x / W) * 3 + e.seed) + Math.cos((y / H) * 4 + (x / W) * 1.3)) * 0.25 + 0.5, rad = step * 0.38 * v;
        if (rad > step * 0.06) { c.beginPath(); c.arc(x, y, rad, 0, TAU); c.fillStyle = e.col(e.alpha * 0.55); c.fill(); }
      }
    });
  },
  grid(e) {
    const { c, W, H } = e, step = W * 0.1 * e.scale;
    c.strokeStyle = e.col(e.alpha * 0.25); c.lineWidth = W * 0.002; c.beginPath();
    sweep(e, step, (x) => { c.moveTo(x, 0); c.lineTo(x, H); });
    for (let y = 0; y <= H; y += step) { c.moveTo(e.x0 - W, y); c.lineTo(e.x1 + W, y); }
    c.stroke();
  },
  triangles(e) {
    const { c, W, H } = e;
    each(e, 7, (j, k, r) => {
      const s = W * (0.05 + 0.14 * r(3)) * e.scale;
      c.save(); c.translate((j + r(1)) * W, r(2) * H); c.rotate(r(4) * TAU);
      c.beginPath(); c.moveTo(0, -s); c.lineTo(s * 0.87, s * 0.5); c.lineTo(-s * 0.87, s * 0.5); c.closePath();
      if (k % 2) { c.lineWidth = W * 0.004; c.strokeStyle = e.col(e.alpha * 0.5); c.stroke(); } else { c.fillStyle = e.col(e.alpha * 0.28); c.fill(); }
      c.restore();
    });
  },
  hexagons(e) {
    const { c, W, H } = e, s = W * 0.06 * e.scale, hh = Math.sqrt(3) * s;
    c.lineWidth = W * 0.0025;
    for (let col = Math.floor(e.x0 / (1.5 * s)) - 1; col * 1.5 * s <= e.x1 + s; col++) {
      for (let row = -1; row * hh <= H + hh; row++) {
        const cx = col * 1.5 * s, cy = row * hh + (col & 1 ? hh / 2 : 0);
        if (Math.sin((cx / W) * 2.1 + e.seed) * Math.cos((cy / H) * 3 + (cx / W) * 0.7) < 0.15) continue;
        c.beginPath();
        for (let q = 0; q < 6; q++) { const a = (q / 6) * TAU; c[q ? "lineTo" : "moveTo"](cx + Math.cos(a) * s * 0.94, cy + Math.sin(a) * s * 0.94); }
        c.closePath(); c.fillStyle = e.col(e.alpha * 0.16); c.fill(); c.strokeStyle = e.col(e.alpha * 0.35); c.stroke();
      }
    }
  },
  sparkles(e) {
    const { c, W, H } = e;
    each(e, 9, (j, _k, r) => {
      const s = W * (0.02 + 0.07 * r(3)) * e.scale;
      c.save(); c.translate((j + r(1)) * W, r(2) * H); c.beginPath();
      c.moveTo(0, -s); c.quadraticCurveTo(0, 0, s, 0); c.quadraticCurveTo(0, 0, 0, s); c.quadraticCurveTo(0, 0, -s, 0); c.quadraticCurveTo(0, 0, 0, -s);
      c.fillStyle = e.col(e.alpha * 0.8); c.fill(); c.restore();
    });
  },
  ribbons(e) {
    const { c, W, H } = e;
    for (let b = 0; b < 3; b++) {
      const y = (x: number) => H * (0.22 + 0.27 * b) + H * 0.12 * Math.sin((x / W) * 1.3 / e.scale + b * 2 + e.seed);
      const w = (x: number) => H * (0.05 + 0.03 * Math.sin((x / W) * 2 + b)) * e.scale;
      c.beginPath();
      let first = true;
      sweep(e, W / 40, (x) => { c[first ? "moveTo" : "lineTo"](x, y(x) - w(x)); first = false; });
      const xs: number[] = []; sweep(e, W / 40, (x) => xs.push(x));
      for (let q = xs.length - 1; q >= 0; q--) c.lineTo(xs[q], y(xs[q]) + w(xs[q]));
      c.closePath(); c.fillStyle = e.col(e.alpha * 0.2); c.fill();
    }
  },
  arcs(e) {
    const { c, W, H } = e;
    c.lineWidth = W * 0.05 * e.scale;
    for (let j = e.j0; j <= e.j1; j++) {
      const cx = (j + (j & 1)) * W, cy = j & 1 ? 0 : H;
      [0.35, 0.58, 0.82, 1.08].forEach((rr, q) => { c.beginPath(); c.arc(cx, cy, W * rr * e.scale, 0, TAU); c.strokeStyle = e.col(e.alpha * (0.22 - q * 0.04)); c.stroke(); });
    }
  },
  aurora(e) {
    const { c, W, H } = e;
    each(e, 3, (j, _k, r) => {
      const cx = (j + r(1)) * W, cy = H * (0.2 + 0.6 * r(2)), rad = W * (0.5 + 0.4 * r(3)) * e.scale;
      c.save(); c.translate(cx, cy); c.rotate((r(4) - 0.5) * 1.2); c.scale(0.45, 1.5);
      const g = c.createRadialGradient(0, 0, 0, 0, 0, rad);
      g.addColorStop(0, e.col(e.alpha * 0.45)); g.addColorStop(1, e.col(0));
      c.fillStyle = g; c.fillRect(-rad, -rad, rad * 2, rad * 2); c.restore();
    });
  },
  confetti(e) {
    const { c, W, H } = e;
    each(e, 26, (j, _k, r) => {
      const w = W * (0.012 + 0.025 * r(3)) * e.scale;
      c.save(); c.translate((j + r(1)) * W, r(2) * H); c.rotate(r(4) * TAU);
      c.fillStyle = e.col(e.alpha * (0.35 + 0.5 * r(5))); c.beginPath(); c.roundRect(-w, -w * 0.4, w * 2, w * 0.8, w * 0.2); c.fill(); c.restore();
    });
  },
  contours(e) {
    const { c, W, H } = e;
    c.lineWidth = W * 0.0025; c.strokeStyle = e.col(e.alpha * 0.4);
    for (let k = 0; k <= 16; k++) {
      c.beginPath(); let first = true;
      sweep(e, W / 40, (x) => {
        const y = (H * k) / 16 + H * 0.04 * Math.sin((x / W) * 2.4 / e.scale + k * 0.35 + e.seed) + H * 0.03 * Math.sin((x / W) * 5.1 - k * 0.2);
        c[first ? "moveTo" : "lineTo"](x, y); first = false;
      });
      c.stroke();
    }
  },
  squares(e) {
    const { c, W, H } = e;
    each(e, 6, (j, k, r) => {
      const s = W * (0.08 + 0.2 * r(3)) * e.scale;
      c.save(); c.translate((j + r(1)) * W, r(2) * H); c.rotate((r(4) - 0.5) * 1.4); c.beginPath(); c.roundRect(-s / 2, -s / 2, s, s, s * 0.2);
      if (k % 2) { c.lineWidth = W * 0.004; c.strokeStyle = e.col(e.alpha * 0.5); c.stroke(); } else { c.fillStyle = e.col(e.alpha * 0.2); c.fill(); }
      c.restore();
    });
  },
  scales(e) {
    const { c, W, H } = e, r = W * 0.08 * e.scale;
    c.lineWidth = W * 0.003; c.strokeStyle = e.col(e.alpha * 0.3);
    for (let row = 0, y = H * 0.55; y < H + r; row++, y += r * 0.9) {
      for (let x = Math.floor(e.x0 / (2 * r)) * 2 * r - (row & 1 ? r : 0); x < e.x1 + 2 * r; x += 2 * r) { c.beginPath(); c.arc(x, y, r, 0, TAU); c.stroke(); }
    }
  },
};

/** Draws one shape layer. `dark` says whether the background is light (so "auto" picks dark shapes). */
export function drawShapes(c: C, layer: ShapeLayer, env: Omit<Env, "col" | "alpha" | "scale" | "seed" | "c">, dark: boolean) {
  const fn = STYLES[layer.style];
  if (!fn) return;
  const rgb = layer.tone === "custom" ? hex(layer.color) : (layer.tone === "dark" || (layer.tone === "auto" && dark)) ? [10, 14, 25] : [255, 255, 255];
  const col = (a: number) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${Math.max(0, Math.min(1, a))})`;
  c.save();
  fn({ ...env, c, seed: layer.seed, scale: layer.scale, alpha: layer.opacity, col });
  c.restore();
}
const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
