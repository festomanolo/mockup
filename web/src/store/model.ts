// Store listing data model: output targets, palettes, fonts, templates and the editable listing itself.
// Everything here is plain data so it can be saved, validated and exchanged with the AI as JSON.

export type Target = { id: string; store: "apple" | "google"; label: string; w: number; h: number; kind: "phone" | "tablet"; dir: string; max: number };

/** Sizes per Apple's and Google's current screenshot rules (portrait). Re-check them in the consoles before submitting. */
export const TARGETS: Target[] = [
  { id: "ios-iphone-69", store: "apple", label: 'App Store · iPhone 6.9" · 1320×2868', w: 1320, h: 2868, kind: "phone", dir: "app-store/iphone-6.9", max: 10 },
  { id: "ios-iphone-65", store: "apple", label: 'App Store · iPhone 6.5" · 1284×2778', w: 1284, h: 2778, kind: "phone", dir: "app-store/iphone-6.5", max: 10 },
  { id: "ios-ipad-13", store: "apple", label: 'App Store · iPad 13" · 2064×2752', w: 2064, h: 2752, kind: "tablet", dir: "app-store/ipad-13", max: 10 },
  { id: "play-phone", store: "google", label: "Google Play · Phone · 1080×1920", w: 1080, h: 1920, kind: "phone", dir: "google-play/phone", max: 8 },
  { id: "play-tablet", store: "google", label: "Google Play · Tablet 10″ · 1600×2560", w: 1600, h: 2560, kind: "tablet", dir: "google-play/tablet-10", max: 8 },
];
export const FEATURE = { w: 1024, h: 500 };

/** Character limits that matter when writing store text. */
export const LIMITS = { title: 30, subtitle: 30, short: 80, promo: 170, keywords: 100, description: 4000, whatsNew: 4000, headlineWords: 6, sub: 90 } as const;

export type TemplateId = "hero" | "crop" | "textBottom" | "tilt" | "duo" | "bridge" | "tail" | "bigType" | "rings";
export const TEMPLATES: { id: TemplateId; label: string; hint: string }[] = [
  { id: "hero", label: "Hero", hint: "Headline on top, device centered" },
  { id: "crop", label: "Big crop", hint: "Large device running off the bottom" },
  { id: "textBottom", label: "Text below", hint: "Device slides in from the top, headline below" },
  { id: "tilt", label: "Tilt", hint: "Tilted device, left-aligned headline" },
  { id: "duo", label: "Duo", hint: "Two screens overlapping" },
  { id: "bridge", label: "Bridge →", hint: "Device straddles into the next slide (use Bridge end next)" },
  { id: "tail", label: "Bridge end", hint: "Completes the previous slide's bridge" },
  { id: "bigType", label: "Big type", hint: "Oversized headline, small tilted device" },
  { id: "rings", label: "Rings", hint: "Device over concentric rings" },
];

export const FONTS = {
  modern: { label: "Modern sans", css: 'system-ui, -apple-system, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", sans-serif', weight: 800 },
  rounded: { label: "Rounded", css: 'ui-rounded, "SF Pro Rounded", "Hiragino Maru Gothic ProN", Nunito, system-ui, sans-serif', weight: 800 },
  editorial: { label: "Editorial serif", css: '"New York", "Iowan Old Style", Georgia, "Times New Roman", serif', weight: 700 },
  condensed: { label: "Condensed", css: '"Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", Impact, sans-serif', weight: 800 },
} as const;
export type FontId = keyof typeof FONTS;

export type Stop = { c: string; p: number };
export type Gradient = { type: "linear" | "radial"; angle: number; stops: Stop[] };
export type ShapeStyleId =
  | "none" | "blobs" | "bubbles" | "rings" | "waves" | "dunes" | "diagonals" | "dots" | "grid" | "triangles" | "hexagons"
  | "sparkles" | "ribbons" | "arcs" | "aurora" | "confetti" | "contours" | "squares" | "scales";
export type ShapeLayer = { style: ShapeStyleId; tone: "auto" | "light" | "dark" | "custom"; color: string; opacity: number; scale: number; seed: number };
export const SHAPE_STYLES: { id: ShapeStyleId; label: string }[] = [
  { id: "blobs", label: "Blobs" }, { id: "bubbles", label: "Bubbles" }, { id: "rings", label: "Rings" }, { id: "waves", label: "Waves" },
  { id: "dunes", label: "Dunes" }, { id: "diagonals", label: "Diagonals" }, { id: "dots", label: "Halftone" }, { id: "grid", label: "Grid" },
  { id: "triangles", label: "Triangles" }, { id: "hexagons", label: "Honeycomb" }, { id: "sparkles", label: "Sparkles" }, { id: "ribbons", label: "Ribbons" },
  { id: "arcs", label: "Arcs" }, { id: "aurora", label: "Aurora" }, { id: "confetti", label: "Confetti" }, { id: "contours", label: "Flow lines" },
  { id: "squares", label: "Squares" }, { id: "scales", label: "Scales" },
];
export const newShape = (style: ShapeStyleId = "blobs"): ShapeLayer => ({ style, tone: "auto", color: "#ffffff", opacity: 0.6, scale: 1, seed: Math.floor(Math.random() * 1000) });

export type Palette = { id: string; name: string; colors: string[] };
/** Evenly spaced stops for a list of colours. */
export const gradFromColors = (colors: string[], angle = 100, type: Gradient["type"] = "linear"): Gradient => ({
  type, angle, stops: colors.map((c, k) => ({ c, p: colors.length === 1 ? 0 : k / (colors.length - 1) })),
});
/** Hand-picked gradients; the first colour leads the panorama, the rest follow across the slides. */
export const PALETTES: Palette[] = [
  { id: "aurora", name: "Aurora", colors: ["#1f2a6b", "#6a3df0", "#14c8e0"] },
  { id: "sunset", name: "Sunset", colors: ["#ff7a59", "#ff3d77", "#7a2bd6"] },
  { id: "ocean", name: "Ocean", colors: ["#0a3d91", "#1e90ff", "#6fe7ff"] },
  { id: "mint", name: "Mint", colors: ["#0f766e", "#2dd4a4", "#c6f7d0"] },
  { id: "ink", name: "Ink", colors: ["#0b0d12", "#1d2433", "#3b4a6b"] },
  { id: "peach", name: "Peach", colors: ["#ffd9c2", "#ffb199", "#ff8fa3"] },
  { id: "violet", name: "Violet", colors: ["#2b1055", "#7a3cff", "#d16bff"] },
  { id: "forest", name: "Forest", colors: ["#0c2b1d", "#1d6b45", "#7bd88f"] },
  { id: "candy", name: "Candy", colors: ["#ff5fa2", "#ffa14a", "#ffe45e"] },
  { id: "paper", name: "Paper", colors: ["#f4efe6", "#e9dfcf", "#d8c9b0"] },
];

export type Slide = { id: string; template: TemplateId; headline: string; sub: string; shot: number | null };

export type StoreCopy = {
  title: string; subtitle: string; short: string; promo: string; keywords: string; description: string; whatsNew: string;
};
export const EMPTY_COPY: StoreCopy = { title: "", subtitle: "", short: "", promo: "", keywords: "", description: "", whatsNew: "" };

export type Listing = {
  app: { name: string; idea: string; audience: string; tone: string; language: string };
  bg: Gradient;
  shapes: ShapeLayer[];
  seamless: boolean;
  font: FontId;
  textColor: "auto" | "light" | "dark" | "custom";
  textCustom: string;
  deviceId: string;
  tabletId: string;
  finish: number;
  slides: Slide[];
  copy: StoreCopy;
};

let uid = 0;
export const newId = () => `s${Date.now().toString(36)}${(uid++).toString(36)}`;

/** Story-arc defaults: Hook, Pain/benefit, Feature, Feature, Proof… with visual rhythm between templates. */
const RHYTHM: TemplateId[] = ["hero", "crop", "tilt", "bridge", "tail", "textBottom", "duo", "rings", "bigType", "crop"];
export function autoTemplates(n: number): TemplateId[] {
  const out: TemplateId[] = [];
  for (let i = 0; i < n; i++) out.push(RHYTHM[i % RHYTHM.length]);
  // a bridge needs a following slide and a tail needs a preceding bridge
  for (let i = 0; i < n; i++) {
    if (out[i] === "bridge" && i + 1 >= n) out[i] = "crop";
    if (out[i] === "tail" && out[i - 1] !== "bridge") out[i] = "hero";
  }
  return out;
}

export const SAMPLE_HEADLINES: [string, string][] = [
  ["Your whole day, one tap", "Everything you need, right where you expect it."],
  ["Plan less. Do more.", "Smart suggestions turn goals into simple steps."],
  ["Works beautifully offline", "Keep going on the train, the plane or the trail."],
  ["Share in seconds", "Send a link and everyone is on the same page."],
  ["Private by design", "Your data stays yours, always."],
  ["Loved by thousands", "Join a growing community of happy people."],
];

export function defaultListing(deviceId: string, tabletId: string): Listing {
  const t = autoTemplates(SAMPLE_HEADLINES.length);
  return {
    app: { name: "", idea: "", audience: "", tone: "Friendly and confident", language: "English" },
    bg: gradFromColors(PALETTES[0].colors), shapes: [{ ...newShape("blobs"), seed: 7 }], seamless: true, font: "modern", textColor: "auto", textCustom: "#ffffff",
    deviceId, tabletId, finish: 0,
    slides: SAMPLE_HEADLINES.map(([headline, sub], i) => ({ id: newId(), template: t[i], headline, sub, shot: null })),
    copy: { ...EMPTY_COPY },
  };
}

/** Colour of the gradient at position t (0..1), as [r,g,b]. */
export function gradAt(g: Gradient, t: number): [number, number, number] {
  const st = [...g.stops].sort((a, b) => a.p - b.p);
  const rgb = (hex: string) => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
  if (t <= st[0].p) return rgb(st[0].c) as [number, number, number];
  for (let k = 1; k < st.length; k++) {
    if (t <= st[k].p) {
      const a = rgb(st[k - 1].c), b = rgb(st[k].c), u = (t - st[k - 1].p) / Math.max(1e-6, st[k].p - st[k - 1].p);
      return a.map((v, i) => v + (b[i] - v) * u) as [number, number, number];
    }
  }
  return rgb(st[st.length - 1].c) as [number, number, number];
}

const HEX = /^#[0-9a-f]{6}$/i;
const str = (v: unknown, max: number, d = "") => (typeof v === "string" ? v.slice(0, max) : d);

function sanitizeGradient(raw: any, d: Gradient): Gradient {
  const stops: Stop[] = Array.isArray(raw?.stops)
    ? raw.stops.filter((x: any) => typeof x?.c === "string" && HEX.test(x.c) && Number.isFinite(x?.p)).slice(0, 6).map((x: any) => ({ c: x.c, p: Math.min(1, Math.max(0, x.p)) }))
    : [];
  if (stops.length < 2) return d;
  return { type: raw.type === "radial" ? "radial" : "linear", angle: Number.isFinite(raw.angle) ? ((raw.angle % 360) + 360) % 360 : 100, stops };
}

/** Stored/imported data is untrusted: coerce every field and fall back to defaults. */
export function sanitizeListing(raw: unknown, base: Listing): Listing {
  const r = (raw ?? {}) as Record<string, any>;
  const app = (r.app ?? {}) as Record<string, unknown>;
  const slides: Slide[] = Array.isArray(r.slides)
    ? r.slides.slice(0, 10).map((s: any, i: number) => ({
        id: newId(),
        template: TEMPLATES.some((t) => t.id === s?.template) ? s.template : autoTemplates(10)[i],
        headline: str(s?.headline, 80),
        sub: str(s?.sub, 160),
        shot: Number.isInteger(s?.shot) && s.shot >= 0 && s.shot < 10 ? s.shot : null,
      }))
    : base.slides;
  const copy = (r.copy ?? {}) as Record<string, unknown>;
  const custom = Array.isArray(r.custom) ? r.custom.filter((c: unknown): c is string => typeof c === "string" && HEX.test(c)).slice(0, 4) : [];
  return {
    app: {
      name: str(app.name, 60), idea: str(app.idea, 1500), audience: str(app.audience, 200),
      tone: str(app.tone, 100, base.app.tone), language: str(app.language, 40, base.app.language),
    },
    palette: r.palette === "custom" || PALETTES.some((p) => p.id === r.palette) ? r.palette : base.palette,
    custom: custom.length >= 2 ? custom : base.custom,
    seamless: typeof r.seamless === "boolean" ? r.seamless : base.seamless,
    font: r.font in FONTS ? r.font : base.font,
    textColor: ["auto", "light", "dark"].includes(r.textColor) ? r.textColor : "auto",
    deviceId: typeof r.deviceId === "string" ? r.deviceId : base.deviceId,
    tabletId: typeof r.tabletId === "string" ? r.tabletId : base.tabletId,
    finish: Number.isInteger(r.finish) && r.finish >= 0 && r.finish < 8 ? r.finish : 0,
    slides: slides.length ? slides : base.slides,
    copy: {
      title: str(copy.title, 100), subtitle: str(copy.subtitle, 100), short: str(copy.short, 200), promo: str(copy.promo, 400),
      keywords: str(copy.keywords, 200), description: str(copy.description, 4000), whatsNew: str(copy.whatsNew, 4000),
    },
  };
}
