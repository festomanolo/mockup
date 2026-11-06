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

  // ---------- screenshots ----------
  const shotList = h("div", { class: "shots" });
  const fileIn = aria(h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true, hidden: true }), "Add screenshots");
  const shotMsg = h("p", { class: "status", role: "status" });
  async function addFiles(files: File[]) {
    const imgs = files.filter((f) => f.type.startsWith("image/"));
    for (const f of imgs) {
      if (A.shots.length >= 10) { shotMsg.textContent = "Ten screenshots is the most a store allows."; break; }
      try {
        const r = await importImage(f);
        A.shots.push({ id: r.id, url: r.url, name: f.name });
        shotMsg.textContent = "";
      } catch (e) { shotMsg.textContent = (e as Error).message; shotMsg.classList.add("bad"); }
    }
    drawShots(); rebuildSlides(); schedule();
  }
  function removeShot(k: number) {
    const [s] = A.shots.splice(k, 1);
    dropImage(s.id); URL.revokeObjectURL(s.url);
    for (const sl of L.slides) { if (sl.shot !== null) sl.shot = sl.shot === k ? null : sl.shot > k ? sl.shot - 1 : sl.shot; }
    drawShots(); rebuildSlides(); schedule();
  }
  function drawShots() {
    shotList.replaceChildren(...A.shots.map((s, k) => {
      const rm = h("button", { class: "rm2", textContent: "×", title: "Remove" });
      rm.setAttribute("aria-label", `Remove screenshot ${k + 1}`);
      rm.onclick = () => removeShot(k);
      return h("div", { class: "shot" }, Object.assign(new Image(), { src: s.url, alt: s.name }), h("span", {}, String(k + 1)), rm);
    }));
  }
  const drop = h("div", { class: "drop", tabIndex: 0 }, h("strong", {}, "Add app screenshots"), h("br"), h("small", {}, "PNG, JPEG or WebP, up to 10 · drop, paste or click · sample screens are shown until you add yours"));
  drop.onclick = () => fileIn.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileIn.click(); } };
  fileIn.onchange = () => { void addFiles([...(fileIn.files ?? [])]); fileIn.value = ""; };

  // ---------- design ----------
  const palRow = h("div", { class: "bgs" });
  const customRow = h("div", { class: "row tight" });
  const gradCss = (cs: string[]) => `linear-gradient(135deg, ${cs.join(", ")})`;
  function drawPalettes() {
    palRow.replaceChildren(...PALETTES.map((p) => {
      const b = h("button", { class: "bgchip", title: p.name });
      b.setAttribute("aria-label", `${p.name} palette`);
      b.setAttribute("aria-pressed", String(L.palette === p.id));
      b.style.background = gradCss(p.colors);
      b.onclick = () => { L.palette = p.id; L.custom = [...p.colors]; drawPalettes(); schedule(); };
      return b;
    }), (() => {
      const b = h("button", { class: "chip", textContent: "Custom" });
      b.setAttribute("aria-pressed", String(L.palette === "custom"));
      b.onclick = () => { L.palette = "custom"; drawPalettes(); schedule(); };
      return b;
    })());
    customRow.replaceChildren(...(L.palette === "custom" ? L.custom.map((c, k) => {
      const inp = aria(h("input", { type: "color", value: c }), `Custom colour ${k + 1}`);
      inp.oninput = () => { L.custom[k] = inp.value; schedule(); };
      return inp;
    }) : []));
  }
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
  const inkSel = sel("Text colour", [["auto", "Auto (best contrast)"], ["light", "Light"], ["dark", "Dark"]], L.textColor, (v) => { L.textColor = v as Listing["textColor"]; schedule(); });
  const seamless = h("input", { type: "checkbox", checked: L.seamless });
  seamless.onchange = () => { L.seamless = seamless.checked; schedule(); };
  const kindSel = sel("Preview as", [["phone", "Preview: phone"], ["tablet", "Preview: tablet"]], previewKind, (v) => { previewKind = v as "phone" | "tablet"; schedule(); });

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
