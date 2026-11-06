// Store listing studio: describe the app, let the (optional) AI draft the words, edit everything by hand, and export
// App Store / Google Play screenshot sets as a ZIP. The AI never touches the design or your screenshots.
import { dropImage, importImage } from "../engine";
import { zip } from "../zip";
import {
  type AiConfig, type Provider, PROVIDERS, generateCopy, listModels, regenerateSlide,
} from "./ai";
import {
  FEATURE, FONTS, LIMITS, PALETTES, TARGETS, TEMPLATES, autoTemplates, defaultListing, newId, sanitizeListing,
  type FontId, type Listing, type StoreCopy, type TemplateId,
} from "./model";
import { type Assets, makePlaceholders, renderFeature, renderSlide, toBlob } from "./render";

export type StoreDevice = { id: string; brand: string; name: string; kind: string; finishes: { name: string; color: string }[] };

type Props<K extends keyof HTMLElementTagNameMap> = Partial<HTMLElementTagNameMap[K]> & { class?: string };
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...kids: (Node | string)[]) => {
  const { class: cls, ...rest } = props as Record<string, unknown>;
  const n = Object.assign(document.createElement(tag), rest);
  if (cls) n.className = cls as string;
  n.append(...kids);
  return n;
};
const card = (title: string, ...kids: (Node | string)[]) => h("section", { class: "pcard" }, h("h2", {}, title), ...kids);
const field = (text: string, ctl: HTMLElement) => h("label", { class: "fld" }, h("span", {}, text), ctl);
const aria = <T extends HTMLElement>(e: T, label: string) => { e.setAttribute("aria-label", label); return e; };

const LS_LISTING = "mockup.store.v1";
const LS_AI = "mockup.store.ai.v1";
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } };
const lsDel = (k: string) => { try { localStorage.removeItem(k); } catch { /* ignore */ } };

const COPY_FIELDS: { key: keyof StoreCopy; label: string; max: number; rows: number; note: string }[] = [
  { key: "title", label: "App name / title", max: LIMITS.title, rows: 1, note: "Apple & Google" },
  { key: "subtitle", label: "Subtitle", max: LIMITS.subtitle, rows: 1, note: "Apple" },
  { key: "short", label: "Short description", max: LIMITS.short, rows: 2, note: "Google Play" },
  { key: "promo", label: "Promotional text", max: LIMITS.promo, rows: 3, note: "Apple · editable without a new release" },
  { key: "keywords", label: "Keywords", max: LIMITS.keywords, rows: 2, note: "Apple · comma-separated, no spaces" },
  { key: "description", label: "Full description", max: LIMITS.description, rows: 8, note: "Apple & Google" },
  { key: "whatsNew", label: "What's new", max: LIMITS.whatsNew, rows: 3, note: "Release notes" },
];

export function storePage(devices: StoreDevice[]): { el: HTMLElement; load: (files: File[]) => void; dispose: () => void } {
  const screens = devices.filter((d) => d.kind === "phone" || d.kind === "tablet");
  const firstPhone = screens.find((d) => d.id === "iphone-15-pro") ?? screens[0];
  const firstTablet = screens.find((d) => d.id === "ipad-pro-11") ?? screens.find((d) => d.kind === "tablet") ?? screens[0];
  const base = defaultListing(firstPhone.id, firstTablet.id);
  let L: Listing = base;
  const saved = lsGet(LS_LISTING);
  if (saved) { try { L = sanitizeListing(JSON.parse(saved), base); } catch { /* corrupt: use defaults */ } }
  if (!screens.some((d) => d.id === L.deviceId)) L.deviceId = base.deviceId;
  if (!screens.some((d) => d.id === L.tabletId)) L.tabletId = base.tabletId;

  const A: Assets = { shots: [], placeholders: [] };
  let icon: { blob: Blob; url: string } | null = null;
  let selected = 0;
  let previewKind: "phone" | "tablet" = "phone";
  let alive = true;
  let aiAbort: AbortController | null = null;
  let exporting = false;

  const persist = () => lsSet(LS_LISTING, JSON.stringify(L));

  // ---------- preview ----------
  const strip = h("div", { class: "sstrip" });
  const stripNote = h("p", { class: "fine sstrip-note" });
  let renderToken = 0;
  let timer = 0;
  const schedule = () => { persist(); clearTimeout(timer); timer = window.setTimeout(() => void paintAll(), 90); };

  const previewTarget = () => TARGETS.find((t) => t.kind === previewKind && exportSel.has(t.id)) ?? TARGETS.find((t) => t.kind === previewKind)!;

  async function paintAll() {
    const my = ++renderToken;
    const t = previewTarget();
    const W = 440, H = Math.round((W * t.h) / t.w);
    while (strip.children.length > L.slides.length) strip.lastElementChild!.remove();
    while (strip.children.length < L.slides.length) {
      const cv = h("canvas", { class: "sslide" });
      cv.tabIndex = 0;
      const idx = strip.children.length;
      cv.onclick = () => select(Number(cv.dataset.i ?? idx));
      cv.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(Number(cv.dataset.i ?? idx)); } };
      strip.append(cv);
    }
    stripNote.textContent = "Loading devices…";
    try {
      for (let i = 0; i < L.slides.length; i++) {
        const cv = strip.children[i] as HTMLCanvasElement;
        cv.dataset.i = String(i);
        cv.setAttribute("aria-label", `Slide ${i + 1}: ${L.slides[i].headline}`);
        cv.style.aspectRatio = `${W} / ${H}`;
        const off = document.createElement("canvas"); // paint off-screen so a stale render never flashes
        await renderSlide(off, L, A, i, W, H, previewKind);
        if (my !== renderToken || !alive) return;
        cv.width = off.width; cv.height = off.height;
        cv.getContext("2d")!.drawImage(off, 0, 0);
      }
      stripNote.textContent = `${L.slides.length} slides · ${L.seamless ? "seamless panorama" : "separate slides"} · preview of ${t.w}×${t.h}`;
    } catch (e) {
      if (my === renderToken) stripNote.textContent = `Preview failed: ${(e as Error).message}`;
    }
    markSelected();
  }
  const markSelected = () => [...strip.children].forEach((c, i) => c.classList.toggle("on", i === selected));

  // ---------- brief + AI ----------
  const aiRaw = lsGet(LS_AI);
  let ai: AiConfig & { remember: boolean } = { provider: "openrouter", baseUrl: PROVIDERS.openrouter.baseUrl, model: "", apiKey: "", remember: false };
  if (aiRaw) { try { const p = JSON.parse(aiRaw); if (p && PROVIDERS[p.provider as Provider]) ai = { ...ai, ...p }; } catch { /* ignore */ } }
  const saveAi = () => { if (ai.remember) lsSet(LS_AI, JSON.stringify(ai)); else lsDel(LS_AI); };

  const nameIn = aria(h("input", { type: "text", maxLength: 60, placeholder: "e.g. Lumen", value: L.app.name }), "App name");
  const ideaIn = aria(h("textarea", { rows: 4, maxLength: 1500, placeholder: "What does the app do, and why do people love it? Mention 3–5 key features.", value: L.app.idea }), "App idea");
  const audIn = aria(h("input", { type: "text", maxLength: 200, placeholder: "e.g. busy parents, solo travelers", value: L.app.audience }), "Audience");
  const toneIn = aria(h("input", { type: "text", maxLength: 100, value: L.app.tone }), "Tone");
  const langIn = aria(h("input", { type: "text", maxLength: 40, value: L.app.language }), "Language");
  for (const [inp, key] of [[nameIn, "name"], [ideaIn, "idea"], [audIn, "audience"], [toneIn, "tone"], [langIn, "language"]] as const) {
    inp.oninput = () => { L.app[key] = inp.value; if (key === "name") schedule(); else persist(); };
  }

  const provSel = aria(h("select"), "AI provider");
  for (const [id, p] of Object.entries(PROVIDERS)) provSel.append(h("option", { value: id, textContent: p.label }));
  provSel.value = ai.provider;
  const urlIn = aria(h("input", { type: "text", value: ai.baseUrl, placeholder: "https://…/v1" }), "Base URL");
  const modelIn = aria(h("input", { type: "text", value: ai.model, placeholder: "model name" }), "Model");
