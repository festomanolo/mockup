// Camera keyframe animation: presets, easing and evaluation.

export type EaseName = "linear" | "easeInOut" | "easeIn" | "easeOut" | "sine" | "expo";

/** Camera pose at normalised time `t` (0..1). Angles in degrees. */
export type Key = {
  t: number;
  yaw: number;
  pitch: number;
  roll: number;
  /** Magnification: 1 = framed to fit, 2 = twice as close. */
  zoom: number;
  /** Pan as a fraction of the device's front extent (+x right, +y up). */
  panX: number;
  panY: number;
  /** Easing applied between this key and the next. */
  ease: EaseName;
};

export const EASES: Record<EaseName, (u: number) => number> = {
  linear: (u) => u,
  easeInOut: (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2),
  easeIn: (u) => u * u * u,
  easeOut: (u) => 1 - Math.pow(1 - u, 3),
  sine: (u) => -(Math.cos(Math.PI * u) - 1) / 2,
  expo: (u) => (u === 0 ? 0 : u === 1 ? 1 : u < 0.5 ? Math.pow(2, 20 * u - 10) / 2 : (2 - Math.pow(2, -20 * u + 10)) / 2),
};
export const EASE_LABELS: Record<EaseName, string> = {
  linear: "Linear", easeInOut: "Ease in-out", easeIn: "Ease in", easeOut: "Ease out", sine: "Smooth (sine)", expo: "Cinematic (expo)",
};

const k = (t: number, o: Partial<Key> = {}): Key => ({ t, yaw: 0, pitch: 0, roll: 0, zoom: 1, panX: 0, panY: 0, ease: "easeInOut", ...o });

export type Preset = { id: string; name: string; hint: string; build(rest: { yaw: number; pitch: number }): Key[] };

/** `rest` is the device's natural resting pose (a slight 3/4 tilt for laptops, straight-on for phones). */
export const PRESETS: Preset[] = [
  { id: "hero", name: "Hero reveal", hint: "Swings in from the side and settles", build: ({ yaw, pitch }) => [
    k(0, { yaw: yaw - 55, pitch: pitch + 12, zoom: 0.8, ease: "easeOut" }), k(1, { yaw, pitch, zoom: 1 })] },
  { id: "push", name: "Slow push-in", hint: "Gentle dolly toward the screen", build: ({ yaw, pitch }) => [
    k(0, { yaw, pitch, zoom: 0.9, ease: "sine" }), k(1, { yaw, pitch, zoom: 1.35 })] },
  { id: "pull", name: "Pull-out", hint: "Start on the screen, reveal the device", build: ({ yaw, pitch }) => [
    k(0, { yaw, pitch, zoom: 2.2, ease: "expo" }), k(1, { yaw, pitch, zoom: 1 })] },
  { id: "orbit", name: "Orbit 360°", hint: "Full turn around the device", build: ({ pitch }) => [
    k(0, { yaw: 0, pitch: pitch + 6, ease: "linear" }), k(1, { yaw: 360, pitch: pitch + 6 })] },
  { id: "orbit-half", name: "Half orbit", hint: "Sweep from left side to right side", build: ({ pitch }) => [
    k(0, { yaw: -40, pitch: pitch + 4, ease: "sine" }), k(1, { yaw: 40, pitch: pitch + 4 })] },
  { id: "pan-lr", name: "Pan left → right", hint: "Slide across with a slight turn", build: ({ yaw, pitch }) => [
    k(0, { yaw: yaw - 10, pitch, zoom: 1.15, panX: -0.28, ease: "sine" }), k(1, { yaw: yaw + 10, pitch, zoom: 1.15, panX: 0.28 })] },
  { id: "tilt-up", name: "Tilt up", hint: "Rise from the base to the screen", build: ({ yaw }) => [
    k(0, { yaw, pitch: 38, zoom: 1.1, panY: 0.12, ease: "easeOut" }), k(1, { yaw, pitch: 0, zoom: 1.05 })] },
  { id: "tilt-down", name: "Tilt down", hint: "Look down onto the device", build: ({ yaw }) => [
    k(0, { yaw, pitch: -6, zoom: 1, ease: "easeOut" }), k(1, { yaw, pitch: 42, zoom: 1.1 })] },
  { id: "spiral", name: "Spiral in", hint: "Orbit while closing in", build: ({ yaw, pitch }) => [
    k(0, { yaw: yaw - 140, pitch: pitch + 18, zoom: 0.75, ease: "easeInOut" }), k(1, { yaw, pitch, zoom: 1.25 })] },
  { id: "swing", name: "Pendulum", hint: "Swings left and right, loops cleanly", build: ({ yaw, pitch }) => [
    k(0, { yaw: yaw - 24, pitch, ease: "sine" }), k(0.5, { yaw: yaw + 24, pitch, ease: "sine" }), k(1, { yaw: yaw - 24, pitch })] },
  { id: "float", name: "Float", hint: "Soft breathing motion, loops cleanly", build: ({ yaw, pitch }) => [
    k(0, { yaw: yaw - 8, pitch: pitch - 2, panY: -0.02, ease: "sine" }), k(0.5, { yaw: yaw + 8, pitch: pitch + 4, panY: 0.03, ease: "sine" }), k(1, { yaw: yaw - 8, pitch: pitch - 2, panY: -0.02 })] },
  { id: "dutch", name: "Dutch roll", hint: "Tilted horizon that levels out", build: ({ yaw, pitch }) => [
    k(0, { yaw: yaw + 25, pitch: pitch + 8, roll: -14, zoom: 1.1, ease: "easeOut" }), k(1, { yaw, pitch, roll: 0, zoom: 1 })] },
  { id: "macro", name: "Macro fly-through", hint: "Close on the screen, pull back, orbit", build: ({ yaw, pitch }) => [
    k(0, { yaw, pitch, zoom: 2.6, panY: 0.05, ease: "easeOut" }), k(0.45, { yaw, pitch, zoom: 1.05, ease: "sine" }), k(1, { yaw: yaw + 35, pitch: pitch + 6, zoom: 1.2 })] },
  { id: "static", name: "Static", hint: "Locked-off front view", build: ({ yaw, pitch }) => [k(0, { yaw, pitch }), k(1, { yaw, pitch })] },
];

export type Pose = { yaw: number; pitch: number; roll: number; zoom: number; panX: number; panY: number };

/** Evaluates the keyframes at u in 0..1 (clamped); keys must be sorted by t. */
export function evaluate(keys: Key[], u: number): Pose {
  u = Math.min(1, Math.max(0, u));
  if (keys.length === 1 || u <= keys[0].t) return keys[0];
  const last = keys[keys.length - 1];
  if (u >= last.t) return last;
  let i = 0;
  while (i < keys.length - 2 && u > keys[i + 1].t) i++;
  const a = keys[i], b = keys[i + 1];
  const span = Math.max(1e-6, b.t - a.t);
  const e = EASES[a.ease]((u - a.t) / span);
  const l = (x: number, y: number) => x + (y - x) * e;
  // zoom interpolates geometrically so a push-in feels constant-speed
  return { yaw: l(a.yaw, b.yaw), pitch: l(a.pitch, b.pitch), roll: l(a.roll, b.roll), zoom: a.zoom * Math.pow(b.zoom / a.zoom, e), panX: l(a.panX, b.panX), panY: l(a.panY, b.panY) };
}
