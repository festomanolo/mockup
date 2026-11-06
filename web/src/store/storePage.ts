// Store listing studio: describe the app, let the (optional) AI draft the words, edit everything by hand, and export
// App Store / Google Play screenshot sets as a ZIP. The AI never touches the design or your screenshots.
import { dropImage } from "../engine";
import { zip } from "../zip";
import {
  type AiConfig, type Provider, PROVIDERS, generateCopy, listModels, regenerateSlide,
} from "./ai";
import {
  FEATURE, FONTS, LIMITS, PALETTES, SHAPE_STYLES, TARGETS, TEMPLATES, autoTemplates, defaultListing, gradAt, gradFromColors, newId, newShape, sanitizeListing,
  type FontId, type Listing, type ShapeLayer, type ShapeStyleId, type StoreCopy, type TemplateId,
} from "./model";
import { type Assets, makePlaceholders, renderFeature, renderShapePreview, renderSlide, toBlob } from "./render";
import { library } from "../library";

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
  if (library.deviceChosen && screens.some((d) => d.id === library.deviceId)) { L.deviceId = library.deviceId; L.finish = library.finish; }
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
  modelIn.setAttribute("list", "store-models");
  const models = h("datalist", { id: "store-models" });
  const keyIn = aria(h("input", { type: "password", value: ai.apiKey, placeholder: "sk-…", autocomplete: "off" }), "API key");
  const remember = h("input", { type: "checkbox", checked: ai.remember });
  const consent = h("input", { type: "checkbox" });
  const aiNote = h("p", { class: "fine" });
  const aiStatus = h("p", { class: "status", role: "status" });
  const genBtn = h("button", { class: "primary", textContent: "✨ Write the words with AI" });
  const stopBtn = h("button", { class: "chip", textContent: "Stop", hidden: true });

  const syncAiUi = () => {
    const p = PROVIDERS[ai.provider];
    urlIn.disabled = ai.provider !== "custom" && ai.provider !== "ollama";
    keyIn.parentElement!.style.display = p.needsKey || ai.provider === "custom" ? "" : "none";
    aiNote.textContent = `Only the text you typed above (name, idea, audience, tone, language) is sent to ${p.label} (${p.host}). Screenshots and images never leave this page.`;
    consentText.textContent = `I understand my app description will be sent to ${p.label}.`;
  };
  const consentText = h("span");
  const refreshModels = async () => {
    const list = await listModels(ai);
    models.replaceChildren(...list.slice(0, 400).map((m) => h("option", { value: m })));
    if (ai.provider === "ollama" && !ai.model && list[0]) { ai.model = list[0]; modelIn.value = list[0]; }
  };
  provSel.onchange = () => {
    ai.provider = provSel.value as Provider;
    ai.baseUrl = PROVIDERS[ai.provider].baseUrl || ai.baseUrl;
    urlIn.value = ai.baseUrl; consent.checked = false;
    syncAiUi(); saveAi(); void refreshModels();
  };
  urlIn.onchange = () => { ai.baseUrl = urlIn.value.trim(); saveAi(); void refreshModels(); };
  modelIn.oninput = () => { ai.model = modelIn.value.trim(); saveAi(); };
  keyIn.oninput = () => { ai.apiKey = keyIn.value.trim(); saveAi(); };
  remember.onchange = () => { ai.remember = remember.checked; saveAi(); };

  const brief = () => ({ ...L.app });
  const aiReady = (): string | null => {
    if (!consent.checked) return "Tick the box to confirm what will be sent.";
    if (L.app.idea.trim().length < 12) return "Describe the app first (at least a sentence).";
    if (!ai.model) return "Choose a model.";
    if (PROVIDERS[ai.provider].needsKey && !ai.apiKey) return "Paste your API key.";
    if (!/^https?:\/\//.test(ai.baseUrl)) return "Enter a valid base URL.";
    return null;
  };
  const say = (msg: string, bad = false) => { aiStatus.textContent = msg; aiStatus.classList.toggle("bad", bad); };
  const setBusy = (b: boolean) => { genBtn.disabled = b; stopBtn.hidden = !b; };

  genBtn.onclick = async () => {
    const why = aiReady();
    if (why) return say(why, true);
    aiAbort = new AbortController(); setBusy(true); say("Writing…");
    try {
      const r = await generateCopy(ai, brief(), L.slides.length, aiAbort.signal);
      r.slides.forEach((s, i) => { L.slides[i].headline = s.headline; L.slides[i].sub = s.sub; });
      L.copy = { ...L.copy, ...r.store };
      if (!L.app.name.trim() && r.store.title) { L.app.name = r.store.title.split(/[:\-–—|]/)[0].trim(); nameIn.value = L.app.name; }
      rebuildSlides(); rebuildCopy(); schedule();
      say(`Done. Review and edit everything below.${r.warnings.length ? " " + r.warnings.join(" ") : ""}`, r.warnings.length > 0);
    } catch (e) {
      say((e as Error).name === "AbortError" ? "Stopped." : (e as Error).message, (e as Error).name !== "AbortError");
    } finally { setBusy(false); aiAbort = null; }
  };
  stopBtn.onclick = () => aiAbort?.abort();

  // ---------- screenshots (shared library) ----------
  const syncShots = () => {
    A.shots = library.get("store").map((x) => ({ id: x.id, url: x.url, name: x.name, file: x.file, w: x.w, h: x.h, framed: x.framed }));
  };
  syncShots();
  const shotList = h("div", { class: "shots" });
  const fileIn = aria(h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true, hidden: true }), "Add screenshots");
  const mockIn = aria(h("input", { type: "file", accept: "image/png,image/webp", multiple: true, hidden: true }), "Add finished mockups");
  const shotMsg = h("p", { class: "status", role: "status" });
  async function addFiles(files: File[], framed?: boolean) {
    const before = new Set(library.shots.map((x) => x.id));
    const errs = await library.add(files, framed === undefined ? {} : { framed });
    for (const x of library.shots) if (!before.has(x.id)) library.set(x.id, { store: true });
    shotMsg.textContent = errs.join(" ");
    shotMsg.classList.toggle("bad", errs.length > 0);
  }
  function drawShots() {
    shotList.replaceChildren(...library.get("store").map((x, k) => {
      const rm = h("button", { class: "rm2", textContent: "×", title: "Take out of the store listing" });
      rm.setAttribute("aria-label", `Remove screenshot ${k + 1} from the listing`);
      rm.onclick = () => library.set(x.id, { store: false });
      const mode = h("button", { class: "mode", textContent: x.framed ? "Mockup" : "Raw", title: x.framed ? "Finished mockup: used as it is. Click to treat as a raw screenshot." : "Raw screenshot: placed in the chosen device. Click if this is already a finished mockup." });
      mode.setAttribute("aria-pressed", String(x.framed));
      mode.onclick = () => library.set(x.id, { framed: !x.framed });
      return h("div", { class: "shot" }, Object.assign(new Image(), { src: x.url, alt: x.name }), h("span", {}, String(k + 1)), rm, mode);
    }));
  }
  const drop = h("div", { class: "drop", tabIndex: 0 }, h("strong", {}, "Add app screenshots"), h("br"), h("small", {}, "Raw screens go into the chosen device · transparent PNGs are treated as finished mockups · sample screens show until you add yours"));
  drop.onclick = () => fileIn.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileIn.click(); } };
  fileIn.onchange = () => { void addFiles([...(fileIn.files ?? [])]); fileIn.value = ""; };
  const mockBtn = h("button", { class: "chip", textContent: "Add finished mockups…" });
  mockBtn.onclick = () => mockIn.click();
  mockIn.onchange = () => { void addFiles([...(mockIn.files ?? [])], true); mockIn.value = ""; };
  const unsub = library.on(() => { syncShots(); drawShots(); rebuildSlides(); schedule(); });

  // ---------- design ----------
  const sel = (label: string, opts: [string, string][], value: string, on: (v: string) => void) => {
    const s = aria(h("select"), label);
    for (const [v, t] of opts) s.append(h("option", { value: v, textContent: t }));
    s.value = value; s.onchange = () => on(s.value);
    return s;
  };
  const devOpts = screens.map((d): [string, string] => [d.id, `${d.brand} ${d.name}`]);
  const finishSel = aria(h("select"), "Device colour");
  const fillFinish = () => {
    const d = screens.find((x) => x.id === L.deviceId)!;
    finishSel.replaceChildren(...d.finishes.map((f, k) => h("option", { value: String(k), textContent: f.name })));
    if (L.finish >= d.finishes.length) L.finish = 0;
    finishSel.value = String(L.finish);
  };
  const phoneSel = sel("Phone device", devOpts, L.deviceId, (v) => { L.deviceId = v; fillFinish(); schedule(); });
  const tabletSel = sel("Tablet device", devOpts, L.tabletId, (v) => { L.tabletId = v; schedule(); });
  finishSel.onchange = () => { L.finish = Number(finishSel.value); schedule(); };
  fillFinish();
  const fontSel = sel("Headline font", Object.entries(FONTS).map(([k, f]): [string, string] => [k, f.label]), L.font, (v) => { L.font = v as FontId; schedule(); });
  const inkCustom = aria(h("input", { type: "color", value: L.textCustom }), "Custom text colour");
  inkCustom.oninput = () => { L.textCustom = inkCustom.value; schedule(); };
  const inkSel = sel("Text colour", [["auto", "Auto (best contrast)"], ["light", "Light"], ["dark", "Dark"], ["custom", "Custom…"]], L.textColor, (v) => { L.textColor = v as Listing["textColor"]; inkCustom.style.display = v === "custom" ? "" : "none"; schedule(); });
  inkCustom.style.display = L.textColor === "custom" ? "" : "none";
  const seamless = h("input", { type: "checkbox", checked: L.seamless });
  seamless.onchange = () => { L.seamless = seamless.checked; schedule(); };
  const kindSel = sel("Preview as", [["phone", "Preview: phone"], ["tablet", "Preview: tablet"]], previewKind, (v) => { previewKind = v as "phone" | "tablet"; schedule(); });

  // ---------- design: gradient editor ----------
  const hex2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  const toHex = (rgb: number[]) => `#${hex2(rgb[0])}${hex2(rgb[1])}${hex2(rgb[2])}`;
  const hsl = (hh: number, ss: number, ll: number) => {
    const a = ss * Math.min(ll, 1 - ll), f = (n: number) => { const k = (n + hh / 30) % 12; return ll - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
  };
  const cssGrad = (g: Listing["bg"]) => {
    const st = [...g.stops].sort((p, q) => p.p - q.p).map((x) => `${x.c} ${Math.round(x.p * 100)}%`).join(", ");
    return g.type === "radial" ? `radial-gradient(circle, ${st})` : `linear-gradient(${g.angle}deg, ${st})`;
  };
  const gradBar = h("div", { class: "gradbar" });
  const stopRows = h("div", { class: "stops" });
  const presetRow = h("div", { class: "bgs" });
  const angleIn = aria(h("input", { type: "range", min: "0", max: "360", step: "1", value: String(L.bg.angle) }), "Gradient angle");
  const angleOut = h("span", { class: "val" });
  const typeSel = sel("Gradient type", [["linear", "Linear"], ["radial", "Radial"]], L.bg.type, (v) => { L.bg.type = v as "linear" | "radial"; drawGrad(); schedule(); });
  angleIn.oninput = () => { L.bg.angle = Number(angleIn.value); drawGrad(false); schedule(); };
  function drawGrad(rebuildRows = true) {
    gradBar.style.background = cssGrad(L.bg);
    angleOut.textContent = `${L.bg.angle}°`;
    angleIn.parentElement!.style.display = L.bg.type === "linear" ? "" : "none";
    if (rebuildRows) {
      stopRows.replaceChildren(...L.bg.stops.map((st, k) => {
        const col = aria(h("input", { type: "color", value: st.c }), `Colour stop ${k + 1}`);
        const pos = aria(h("input", { type: "range", min: "0", max: "100", step: "1", value: String(Math.round(st.p * 100)) }), `Position of stop ${k + 1}`);
        const out = h("span", { class: "val", textContent: `${Math.round(st.p * 100)}%` });
        col.oninput = () => { st.c = col.value; gradBar.style.background = cssGrad(L.bg); drawGallery(); schedule(); };
        pos.oninput = () => { st.p = Number(pos.value) / 100; out.textContent = `${pos.value}%`; gradBar.style.background = cssGrad(L.bg); drawGallery(); schedule(); };
        const rm = h("button", { class: "rm2", textContent: "×", title: "Remove colour", disabled: L.bg.stops.length <= 2 });
        rm.setAttribute("aria-label", `Remove colour stop ${k + 1}`);
        rm.onclick = () => { L.bg.stops.splice(k, 1); drawGrad(); schedule(); };
        return h("div", { class: "stop" }, col, pos, out, rm);
      }));
      drawGallery();
    }
  }
  function drawPresets() {
    presetRow.replaceChildren(...PALETTES.map((p) => {
      const b = h("button", { class: "bgchip", title: p.name });
      b.setAttribute("aria-label", `${p.name} gradient`);
      b.style.background = cssGrad(gradFromColors(p.colors));
      b.onclick = () => { L.bg = gradFromColors(p.colors, L.bg.angle, L.bg.type); angleIn.value = String(L.bg.angle); typeSel.value = L.bg.type; drawGrad(); schedule(); };
      return b;
    }));
  }
  const addStop = h("button", { class: "chip", textContent: "+ Add colour" });
  addStop.onclick = () => {
    if (L.bg.stops.length >= 6) return;
    const st = [...L.bg.stops].sort((p, q) => p.p - q.p);
    let gi = 0, gap = -1;
    for (let k = 0; k < st.length - 1; k++) if (st[k + 1].p - st[k].p > gap) { gap = st[k + 1].p - st[k].p; gi = k; }
    const p = (st[gi].p + st[gi + 1].p) / 2;
    L.bg.stops.push({ p, c: toHex(gradAt(L.bg, p)) });
    L.bg.stops.sort((x, y) => x.p - y.p);
    drawGrad(); schedule();
  };
  const reverseBtn = h("button", { class: "chip", textContent: "Reverse" });
  reverseBtn.onclick = () => { L.bg.stops.forEach((x) => (x.p = 1 - x.p)); L.bg.stops.sort((x, y) => x.p - y.p); drawGrad(); schedule(); };
  const randomBtn = h("button", { class: "chip", textContent: "🎲 Random" });
  randomBtn.onclick = () => {
    const hue = Math.random() * 360, spread = 40 + Math.random() * 80, n = 3;
    L.bg.stops = Array.from({ length: n }, (_, k) => ({ p: k / (n - 1), c: hsl((hue + k * spread) % 360, 0.65 + Math.random() * 0.25, k === 0 ? 0.28 + Math.random() * 0.12 : 0.5 + k * 0.06) }));
    drawGrad(); schedule();
  };

  // ---------- design: background shapes ----------
  const gallery = h("div", { class: "shapegal" });
  const layerBox = h("div", { class: "layers" });
  let activeLayer = 0;
  function drawGallery() {
    const none = h("button", { class: "shapechip", title: "No shapes" }, h("span", { class: "nonebox", textContent: "∅" }), h("small", {}, "None"));
    none.setAttribute("aria-pressed", String(L.shapes.length === 0));
    none.onclick = () => { L.shapes = []; drawGallery(); drawLayers(); schedule(); };
    gallery.replaceChildren(none, ...SHAPE_STYLES.map((t) => {
      const cv = document.createElement("canvas"); cv.width = 120; cv.height = 72;
      renderShapePreview(cv, L.bg, { ...(L.shapes[activeLayer] ?? newShape(t.id)), style: t.id });
      const b = h("button", { class: "shapechip", title: t.label }, cv, h("small", {}, t.label));
      b.setAttribute("aria-pressed", String(L.shapes.some((x) => x.style === t.id)));
      b.onclick = () => {
        if (!L.shapes.length) { L.shapes.push(newShape(t.id)); activeLayer = 0; } else L.shapes[Math.min(activeLayer, L.shapes.length - 1)].style = t.id;
        drawGallery(); drawLayers(); schedule();
      };
      return b;
    }));
  }
  function drawLayers() {
    layerBox.replaceChildren(...L.shapes.map((ly, k) => {
      const style = sel(`Shape layer ${k + 1} style`, SHAPE_STYLES.map((t): [string, string] => [t.id, t.label]), ly.style, (v) => { ly.style = v as ShapeStyleId; activeLayer = k; drawGallery(); schedule(); });
      const col = aria(h("input", { type: "color", value: ly.color }), `Shape layer ${k + 1} colour`);
      col.style.display = ly.tone === "custom" ? "" : "none";
      col.oninput = () => { ly.color = col.value; schedule(); };
      const tone = sel(`Shape layer ${k + 1} tone`, [["auto", "Auto"], ["light", "Light"], ["dark", "Dark"], ["custom", "Custom"]], ly.tone, (v) => { ly.tone = v as ShapeLayer["tone"]; col.style.display = v === "custom" ? "" : "none"; schedule(); });
      const opacity = aria(h("input", { type: "range", min: "5", max: "100", value: String(Math.round(ly.opacity * 100)) }), `Shape layer ${k + 1} opacity`);
      opacity.oninput = () => { ly.opacity = Number(opacity.value) / 100; schedule(); };
      const size = aria(h("input", { type: "range", min: "40", max: "250", value: String(Math.round(ly.scale * 100)) }), `Shape layer ${k + 1} size`);
      size.oninput = () => { ly.scale = Number(size.value) / 100; schedule(); };
      const dice = h("button", { class: "rm2", textContent: "🎲", title: "Shuffle positions" });
      dice.setAttribute("aria-label", `Shuffle shape layer ${k + 1}`);
      dice.onclick = () => { ly.seed = Math.floor(Math.random() * 1000); schedule(); };
      const rm = h("button", { class: "rm2", textContent: "×", title: "Remove layer" });
      rm.setAttribute("aria-label", `Remove shape layer ${k + 1}`);
      rm.onclick = () => { L.shapes.splice(k, 1); activeLayer = 0; drawGallery(); drawLayers(); schedule(); };
      const row = h("div", { class: "layer" + (k === activeLayer ? " on" : "") },
        h("div", { class: "lhead" }, h("strong", {}, `Layer ${k + 1}`), style, tone, col, dice, rm),
        h("label", { class: "fine range" }, "Opacity", opacity), h("label", { class: "fine range" }, "Size", size));
      row.onfocusin = () => { activeLayer = k; layerBox.querySelectorAll(".layer").forEach((el2, q) => el2.classList.toggle("on", q === k)); };
      return row;
    }));
  }
  const addLayer = h("button", { class: "chip", textContent: "+ Add shape layer" });
  addLayer.onclick = () => {
    if (L.shapes.length >= 3) return;
    const used = new Set(L.shapes.map((x) => x.style));
    L.shapes.push(newShape((SHAPE_STYLES.find((t) => !used.has(t.id)) ?? SHAPE_STYLES[0]).id));
    activeLayer = L.shapes.length - 1; drawGallery(); drawLayers(); schedule();
  };

  // ---------- slides ----------
  const slideBox = h("div", { class: "slides" });
  const fixBridges = () => {
    L.slides.forEach((s, i) => {
      if (s.template === "bridge" && i + 1 >= L.slides.length) s.template = "crop";
      if (s.template === "bridge" && L.slides[i + 1].template !== "tail") L.slides[i + 1].template = "tail";
      if (s.template === "tail" && L.slides[i - 1]?.template !== "bridge") s.template = "hero";
    });
  };
  function select(i: number) {
    selected = Math.max(0, Math.min(L.slides.length - 1, i));
    markSelected();
    [...slideBox.children].forEach((c, k) => c.classList.toggle("on", k === selected));
    slideBox.children[selected]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function rebuildSlides() {
    fixBridges();
    slideBox.replaceChildren(...L.slides.map((s, i) => {
      const hl = aria(h("input", { type: "text", maxLength: 80, value: s.headline, placeholder: "Headline (≤ 6 words)" }), `Slide ${i + 1} headline`);
      const wc = h("span", { class: "wc" });
      const upd = () => { const n = s.headline.trim() ? s.headline.trim().split(/\s+/).length : 0; wc.textContent = `${n}/${LIMITS.headlineWords} words`; wc.classList.toggle("bad", n > LIMITS.headlineWords); };
      upd();
      hl.oninput = () => { s.headline = hl.value; upd(); schedule(); };
      const sub = aria(h("input", { type: "text", maxLength: 160, value: s.sub, placeholder: "One supporting line" }), `Slide ${i + 1} sub-line`);
      sub.oninput = () => { s.sub = sub.value; schedule(); };
      const tpl = aria(h("select"), `Slide ${i + 1} layout`);
      for (const t of TEMPLATES) tpl.append(h("option", { value: t.id, textContent: t.label, title: t.hint }));
      tpl.value = s.template;
      tpl.onchange = () => { s.template = tpl.value as TemplateId; rebuildSlides(); schedule(); };
      const shot = aria(h("select"), `Slide ${i + 1} screenshot`);
      shot.append(h("option", { value: "", textContent: "Screen: auto" }));
      A.shots.forEach((_, k) => shot.append(h("option", { value: String(k), textContent: `Screen ${k + 1}` })));
      shot.value = s.shot === null ? "" : String(s.shot);
      shot.onchange = () => { s.shot = shot.value === "" ? null : Number(shot.value); schedule(); };
      const btn = (txt: string, title: string, fn: () => void, dis = false) => {
        const b = h("button", { class: "rm2", textContent: txt, title, disabled: dis });
        b.setAttribute("aria-label", `${title} (slide ${i + 1})`);
        b.onclick = (e) => { e.stopPropagation(); fn(); };
        return b;
      };
      const move = (d: number) => { const j = i + d; [L.slides[i], L.slides[j]] = [L.slides[j], L.slides[i]]; selected = j; rebuildSlides(); schedule(); };
      const regen = btn("✨", "Rewrite with AI", async () => {
        const why = aiReady();
        if (why) return say(why, true);
        aiAbort = new AbortController(); setBusy(true); say(`Rewriting slide ${i + 1}…`);
        try {
          const r = await regenerateSlide(ai, brief(), L.slides.map((x) => ({ headline: x.headline, sub: x.sub })), i, aiAbort.signal);
          s.headline = r.headline; s.sub = r.sub; rebuildSlides(); schedule(); say("Done.");
        } catch (e) { say((e as Error).name === "AbortError" ? "Stopped." : (e as Error).message, (e as Error).name !== "AbortError"); }
        finally { setBusy(false); aiAbort = null; }
      });
      const head = h("div", { class: "shead" }, h("strong", {}, `Slide ${i + 1}`), tpl, shot,
        btn("↑", "Move up", () => move(-1), i === 0), btn("↓", "Move down", () => move(1), i === L.slides.length - 1), regen,
        btn("×", "Remove slide", () => { L.slides.splice(i, 1); selected = Math.min(selected, L.slides.length - 1); rebuildSlides(); schedule(); }, L.slides.length <= 1));
      const box = h("div", { class: "slide" + (i === selected ? " on" : "") }, head, hl, wc, sub);
      box.onfocusin = () => { if (selected !== i) { selected = i; markSelected(); [...slideBox.children].forEach((c, k) => c.classList.toggle("on", k === i)); } };
      return box;
    }));
  }
  const addSlide = h("button", { class: "chip", textContent: "+ Add slide" });
  addSlide.onclick = () => {
    if (L.slides.length >= 10) return;
    L.slides.push({ id: newId(), template: autoTemplates(L.slides.length + 1)[L.slides.length], headline: "", sub: "", shot: null });
    selected = L.slides.length - 1; rebuildSlides(); schedule();
  };

  // ---------- store text ----------
  const copyBox = h("div", { class: "copyfields" });
  function rebuildCopy() {
    copyBox.replaceChildren(...COPY_FIELDS.map((f) => {
      const ta = aria(h("textarea", { rows: f.rows, value: L.copy[f.key] }), f.label);
      const cnt = h("span", { class: "wc" });
      const upd = () => { cnt.textContent = `${ta.value.length}/${f.max}`; cnt.classList.toggle("bad", ta.value.length > f.max); };
      upd();
      ta.oninput = () => { L.copy[f.key] = ta.value; upd(); persist(); };
      const cp = h("button", { class: "chip", textContent: "Copy" });
      cp.onclick = () => { void navigator.clipboard?.writeText(ta.value).then(() => { cp.textContent = "Copied"; setTimeout(() => (cp.textContent = "Copy"), 1200); }).catch(() => {}); };
      return h("div", { class: "cf" }, h("div", { class: "cfh" }, h("strong", {}, f.label), h("span", { class: "fine" }, f.note), cnt, cp), ta);
    }));
  }

  // ---------- export ----------
  const exportSel = new Set<string>(["ios-iphone-69", "play-phone"]);
  const fmtSel = sel("Image format", [["image/png", "PNG (sharpest text)"], ["image/jpeg", "JPEG (smaller files)"]], "image/png", () => {});
  const featChk = h("input", { type: "checkbox", checked: true });
  const iconIn = aria(h("input", { type: "file", accept: "image/png,image/jpeg,image/webp" }), "App icon");
  iconIn.onchange = () => {
    const f = iconIn.files?.[0];
    if (icon) URL.revokeObjectURL(icon.url);
    icon = f ? { blob: f, url: URL.createObjectURL(f) } : null;
  };
  const targetBoxes = TARGETS.map((t) => {
    const cb = h("input", { type: "checkbox", checked: exportSel.has(t.id) });
    cb.onchange = () => { if (cb.checked) exportSel.add(t.id); else exportSel.delete(t.id); };
    return h("label", { class: "chk" }, cb, ` ${t.label}`);
  });
  const exStatus = h("p", { class: "status", role: "status" });
  const exBar = h("progress", { max: 1, value: 0, hidden: true });
  const exBtn = h("button", { class: "primary", textContent: "Export listing ZIP" });
  const exMsg = (m: string, bad = false) => { exStatus.textContent = m; exStatus.classList.toggle("bad", bad); };

  const copyText = () => COPY_FIELDS.map((f) => `# ${f.label} (${L.copy[f.key].length}/${f.max})\n${L.copy[f.key]}\n`).join("\n") +
    `\n# Slides\n${L.slides.map((s, i) => `${i + 1}. ${s.headline}${s.sub ? ` — ${s.sub}` : ""}`).join("\n")}\n`;

  exBtn.onclick = async () => {
    if (exporting) return;
    const targets = TARGETS.filter((t) => exportSel.has(t.id));
    if (!targets.length && !featChk.checked && !icon) return exMsg("Choose at least one output.", true);
    exporting = true; exBtn.disabled = true; exBar.hidden = false; exBar.value = 0;
    const type = fmtSel.value as "image/png" | "image/jpeg";
    const ext = type === "image/png" ? "png" : "jpg";
    const files: { name: string; data: Uint8Array }[] = [];
    const bytes = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
    const total = targets.reduce((n, t) => n + Math.min(L.slides.length, t.max), 0) + (featChk.checked ? 1 : 0) + (icon ? 1 : 0);
    let done = 0;
    const tick = () => { exBar.value = ++done / total; };
    try {
      const notes: string[] = [];
      for (const t of targets) {
        const count = Math.min(L.slides.length, t.max);
        if (L.slides.length > t.max) notes.push(`${t.dir}: only the first ${t.max} slides fit.`);
        for (let i = 0; i < count; i++) {
          exMsg(`Rendering ${t.dir} ${i + 1}/${count}…`);
          const cv = document.createElement("canvas");
          await renderSlide(cv, L, A, i, t.w, t.h, t.kind);
          files.push({ name: `${t.dir}/${String(i + 1).padStart(2, "0")}.${ext}`, data: await bytes(await toBlob(cv, type)) });
          cv.width = cv.height = 1;
          tick();
        }
      }
      if (featChk.checked) {
        exMsg("Rendering feature graphic…");
        const cv = document.createElement("canvas");
        await renderFeature(cv, L, A);
        files.push({ name: "google-play/feature-graphic-1024x500.jpg", data: await bytes(await toBlob(cv, "image/jpeg", 0.95)) }); // JPEG: Play forbids alpha
        tick();
      }
      if (icon) {
        const bmp = await createImageBitmap(icon.blob);
        const cv = document.createElement("canvas"); cv.width = cv.height = 512;
        const c = cv.getContext("2d")!; c.imageSmoothingQuality = "high";
        const s = Math.min(bmp.width, bmp.height);
        c.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 512, 512);
        bmp.close();
        files.push({ name: "google-play/icon-512.png", data: await bytes(await toBlob(cv, "image/png")) });
        tick();
      }
      const enc = new TextEncoder();
      files.push({ name: "listing-copy.txt", data: enc.encode(copyText()) });
      files.push({ name: "listing.json", data: enc.encode(JSON.stringify(L, null, 2)) });
      const a = h("a", { href: URL.createObjectURL(zip(files)), download: `${(L.app.name || "store-listing").replace(/[^\w-]+/g, "-")}-store-listing.zip` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      exMsg(`Done: ${files.length} files.${notes.length ? " " + notes.join(" ") : ""} Check sizes against the consoles before uploading.`);
    } catch (e) { exMsg((e as Error).message, true); }
    finally { exporting = false; exBtn.disabled = false; exBar.hidden = true; }
  };

  // project save/load
  const saveProj = h("button", { class: "chip", textContent: "Save project (.json)" });
  saveProj.onclick = () => {
    const a = h("a", { href: URL.createObjectURL(new Blob([JSON.stringify(L, null, 2)], { type: "application/json" })), download: "store-listing.json" });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  };
  const projIn = aria(h("input", { type: "file", accept: "application/json,.json", hidden: true }), "Open project");
  const openProj = h("button", { class: "chip", textContent: "Open project…" });
  openProj.onclick = () => projIn.click();
  projIn.onchange = async () => {
    const f = projIn.files?.[0]; projIn.value = "";
    if (!f) return;
    try {
      L = sanitizeListing(JSON.parse(await f.text()), base);
      syncAll(); schedule();
      exMsg("Project opened. Screenshots are not stored in the file: add them again.");
    } catch { exMsg("That file is not a store-listing project.", true); }
  };

  const reset = h("button", { class: "chip", textContent: "Reset listing" });
  reset.onclick = () => { if (confirm("Reset all text and design to the defaults?")) { L = defaultListing(firstPhone.id, firstTablet.id); syncAll(); schedule(); } };

  function syncAll() {
    nameIn.value = L.app.name; ideaIn.value = L.app.idea; audIn.value = L.app.audience; toneIn.value = L.app.tone; langIn.value = L.app.language;
    phoneSel.value = L.deviceId; tabletSel.value = L.tabletId; fillFinish(); fontSel.value = L.font; inkSel.value = L.textColor; seamless.checked = L.seamless;
    selected = 0; inkCustom.value = L.textCustom; inkCustom.style.display = L.textColor === "custom" ? "" : "none"; angleIn.value = String(L.bg.angle); typeSel.value = L.bg.type; drawGrad(); drawLayers(); rebuildSlides(); rebuildCopy();
  }

  // ---------- assemble ----------
  const left = h("div", { class: "vcol" },
    h("div", { class: "pcard sbar" }, kindSel, h("label", { class: "chk" }, seamless, " Seamless panorama")),
    h("div", { class: "pcard sstage" }, strip, stripNote));
  const side = h("div", { class: "side" },
    card("1 · Your app", field("Name", nameIn), field("What it does", ideaIn), h("div", { class: "row" }, field("Audience", audIn), field("Tone", toneIn)), field("Write in", langIn)),
    card("2 · AI writer (optional)",
      h("p", { class: "fine" }, "The AI writes words only: headlines, sub-lines and store text. You can edit every word, and the design is always done by the app."),
      field("Provider", provSel), field("Base URL", urlIn), field("Model", modelIn), models, field("API key", keyIn),
      h("label", { class: "chk" }, remember, " Remember the key in this browser"),
      aiNote,
      h("label", { class: "chk" }, consent, " ", consentText),
      genBtn, stopBtn, aiStatus),
    card("3 · Screenshots",
      h("p", { class: "fine" }, "Shared with the video studio. ", h("a", { href: "/studio/" }, "Guided studio →"), " turns raw screenshots into mockups and picks the best ones for you."),
      drop, fileIn, mockIn, h("div", { class: "row tight" }, mockBtn), shotList, shotMsg),
    card("4 · Design",
      palRow, customRow,
      h("div", { class: "row" }, field("Font", fontSel), field("Text", inkSel)),
      h("div", { class: "row" }, field("Phone device", phoneSel), field("Colour", finishSel)),
      field("Tablet device (for tablet sets)", tabletSel)),
    card("5 · Slides", slideBox, addSlide),
    card("6 · Store text", copyBox),
    card("7 · Export",
      ...targetBoxes,
      h("label", { class: "chk" }, featChk, ` Google Play feature graphic (${FEATURE.w}×${FEATURE.h})`),
      field("App icon → 512×512 (optional)", iconIn),
      field("Format", fmtSel),
      exBtn, exBar, exStatus,
      h("div", { class: "row tight" }, saveProj, openProj, reset), projIn,
      h("p", { class: "fine" }, "Sizes follow Apple's and Google's published rules at the time of writing; confirm them in App Store Connect and Play Console before uploading. Tablet sets reuse your phone screenshots (cropped to fill): add tablet screenshots for best results.")));

  const el = h("div", {},
    h("h1", {}, "Store listing studio"),
    h("p", { class: "sub" }, "App Store and Google Play screenshots, carousels and text. Draft the words with AI if you like, then edit everything and export a ready-to-upload ZIP."),
    h("div", { class: "layout slayout" }, left, side));

  syncAiUi(); drawPalettes(); rebuildSlides(); rebuildCopy(); drawShots(); void refreshModels();
  void makePlaceholders().then((ids) => { A.placeholders = ids; if (alive) void paintAll(); }).catch(() => { void paintAll(); });

  return {
    el,
    load: (files) => void addFiles(files),
    dispose() {
      alive = false; renderToken++; clearTimeout(timer); aiAbort?.abort();
      for (const s of A.shots) { dropImage(s.id); URL.revokeObjectURL(s.url); }
      for (const id of A.placeholders) dropImage(id);
      if (icon) URL.revokeObjectURL(icon.url);
    },
  };
}
