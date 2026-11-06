// The video studio page: live 3D preview, camera animation, keyframes, scene settings and export.
import { EASE_LABELS, evaluate, PRESETS, type EaseName, type Key } from "./animation";
import type { DeviceSpec } from "./device3d";
import { alphaWebmSupported, exportVideo, MAX_PNG_FRAMES, webCodecsSupported } from "./exporter";
import { DEFAULT_SETTINGS, Stage, type Bg, type LightPreset, type Media } from "./stage";

type Props<K extends keyof HTMLElementTagNameMap> = Partial<HTMLElementTagNameMap[K]> & { class?: string };
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...kids: (Node | string)[]) => {
  const { class: cls, ...rest } = props as Record<string, unknown>;
  const n = Object.assign(document.createElement(tag), rest);
  if (cls) n.className = cls as string;
  n.append(...kids);
  return n;
};
const card = (title: string, ...kids: (Node | string)[]) => h("section", { class: "pcard" }, h("h2", {}, title), ...kids);
const labelled = (text: string, ctl: HTMLElement) => h("label", { class: "fine range" }, text, ctl);
function select(label: string, opts: [string, string][], value: string, on: (v: string) => void) {
  const s = h("select");
  s.setAttribute("aria-label", label);
  for (const [v, t] of opts) s.append(h("option", { value: v, textContent: t }));
  s.value = value;
  s.onchange = () => on(s.value);
  return s;
}
function slider(label: string, min: number, max: number, step: number, value: number, on: (v: number) => void) {
  const s = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(value) });
  s.setAttribute("aria-label", label);
  const out = h("span", { class: "val", textContent: String(value) });
  s.oninput = () => { out.textContent = s.value; on(Number(s.value)); };
  const l = labelled(label, s);
  l.append(out);
  return l;
}

const ASPECTS: Record<string, number> = { "16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1, "4:5": 4 / 5, "21:9": 21 / 9 };
const RES: [string, number][] = [["720p", 1280], ["1080p", 1920], ["1440p", 2560], ["4K", 3840]];
const BG_PRESETS: { label: string; bg: Bg }[] = [
  { label: "Transparent", bg: { kind: "transparent" } },
  { label: "White", bg: { kind: "solid", color: "#ffffff" } },
  { label: "Light gray", bg: { kind: "solid", color: "#eef0f3" } },
  { label: "Black", bg: { kind: "solid", color: "#0f1114" } },
  { label: "Ocean", bg: { kind: "linear", from: "#4facfe", to: "#00f2fe", angle: 135 } },
  { label: "Sunset", bg: { kind: "linear", from: "#fa709a", to: "#fee140", angle: 135 } },
  { label: "Violet", bg: { kind: "linear", from: "#667eea", to: "#764ba2", angle: 135 } },
  { label: "Mint", bg: { kind: "linear", from: "#84fab0", to: "#8fd3f4", angle: 135 } },
  { label: "Peach", bg: { kind: "linear", from: "#ffecd2", to: "#fcb69f", angle: 135 } },
  { label: "Midnight", bg: { kind: "linear", from: "#232526", to: "#414345", angle: 160 } },
];
const bgCss = (b: Bg) => (b.kind === "solid" ? b.color : b.kind === "linear" ? `linear-gradient(${b.angle}deg, ${b.from}, ${b.to})` : b.kind === "image" ? `url(${b.img.src}) center/cover` : "");

export type VideoPage = { el: HTMLElement; load(files: File[]): void; dispose(): void };

export function videoPage(d: DeviceSpec): VideoPage {
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const st = {
    finish: 0, preset: "hero", keys: [] as Key[], duration: 8, easeOverride: "" as "" | EaseName,
    aspect: "16:9", res: 1920, fps: 30, format: "mp4" as "mp4" | "webm" | "png", quality: 0.12, alphaWebm: false,
    media: null as { file: File; url: string; kind: "image" | "video"; duration: number } | null,
    audioFile: null as File | null, useVideoAudio: false, volume: 1, fadeOut: 1,
    playing: !reduceMotion, u: 0, selKey: 0,
  };
  let exporting = false;
  let dirty = true;
  let abort: AbortController | null = null;

  // ---------- stage ----------
  const canvas = h("canvas", { class: "vcanvas" });
  canvas.setAttribute("aria-label", `3D preview of ${d.name}`);
  const stage = new Stage(canvas);
  stage.settings = structuredClone(DEFAULT_SETTINGS);
  if (d.kind === "laptop" || d.kind === "imac") stage.settings.shadow = 0.55; else stage.settings.shadow = 0;
  stage.setDevice(d, 0);
  const wrap = h("div", { class: "vwrap checker" }, canvas);
  const stageCard = h("div", { class: "stagecard vstage" }, wrap);
  const sizeWrap = () => {
    const r = ASPECTS[st.aspect];
    wrap.style.aspectRatio = String(r);
    wrap.style.width = `min(100%, calc(72vh * ${r}))`;
    wrap.classList.toggle("checker", stage.settings.bg.kind === "transparent");
  };
  const resize = () => {
    const r = wrap.getBoundingClientRect();
    if (r.width > 8 && !exporting) { stage.setViewport(r.width, r.height, Math.min(devicePixelRatio, 2)); dirty = true; }
  };
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);

  // ---------- animation ----------
  const rebuildKeys = () => {
    if (st.preset === "custom") return;
    const p = PRESETS.find((x) => x.id === st.preset)!;
    st.keys = p.build(stage.restPose).map((k) => ({ ...k, ease: st.easeOverride || k.ease }));
    st.selKey = Math.min(st.selKey, st.keys.length - 1);
    dirty = true;
  };
  const cycles = () => Math.max(1, Math.round(st.duration / 4));
  const drawNow = () => stage.draw(st.keys, st.u, cycles());

  // ---------- media ----------
  const hint = h("div", { class: "vhint" }, "Add an image or video for the screen");
  wrap.append(hint);
  let videoEl: HTMLVideoElement | null = null;
  let audioEl: HTMLAudioElement | null = null;
  const status = h("div", { class: "status", role: "status" });
  const say = (m: string, err = false) => { status.textContent = m; status.className = "status" + (err ? " err" : ""); };

  const clearMedia = () => {
    if (videoEl) { videoEl.pause(); videoEl.removeAttribute("src"); videoEl.load(); }
    videoEl = null;
    if (st.media) URL.revokeObjectURL(st.media.url);
    st.media = null;
  };
  const loadMedia = async (f: File) => {
    const isVideo = f.type.startsWith("video/");
    if (!isVideo && !/^image\/(png|jpeg|webp|gif|avif|bmp)$/.test(f.type)) throw new Error(`Unsupported file type${f.type ? ` (${f.type})` : ""}. Use PNG, JPEG, WebP, MP4 or WebM.`);
    if (f.size > 500 * 1024 * 1024) throw new Error("File is larger than 500 MB.");
    const url = URL.createObjectURL(f);
    try {
      let media: Media;
      let duration = 0;
      if (isVideo) {
        const v = h("video", { muted: true, loop: true, playsInline: true, preload: "auto", src: url, crossOrigin: "anonymous" });
        await new Promise<void>((ok, fail) => {
          v.onloadeddata = () => ok();
          v.onerror = () => fail(new Error("This video could not be decoded by the browser. Try MP4 (H.264) or WebM."));
        });
        if (v.videoWidth * v.videoHeight > 3840 * 2160 * 1.01) throw new Error("Video is larger than 4K.");
        duration = v.duration;
        media = { kind: "video", el: v, w: v.videoWidth, h: v.videoHeight };
      } else {
        const img = h("img", { src: url });
        try { await img.decode(); } catch { throw new Error("This image could not be decoded; the file may be corrupt."); }
        if (img.naturalWidth * img.naturalHeight > 64e6) throw new Error("Image is too large (limit 64 megapixels).");
        media = { kind: "image", el: img, w: img.naturalWidth, h: img.naturalHeight };
      }
      clearMedia();
      st.media = { file: f, url, kind: media.kind, duration };
      videoEl = media.kind === "video" ? media.el : null;
      stage.setMedia(media);
      hint.style.display = "none";
      mediaInfo.textContent = `${f.name} · ${media.w}×${media.h}${duration ? ` · ${duration.toFixed(1)} s` : ""}`;
      fitBtn.disabled = !duration;
      useVidAudio.disabled = !duration;
      if (duration && st.playing) void videoEl!.play().catch(() => {});
      dirty = true;
    } catch (e) {
      URL.revokeObjectURL(url);
      throw e;
    }
  };
  const load = (files: File[]) => {
    const f = files.find((x) => x.type.startsWith("video/") || x.type.startsWith("image/"));
    if (!f) { if (files.length) say("Drop an image or a video.", true); return; }
    say(`Reading ${f.name}…`);
    loadMedia(f).then(() => say("")).catch((e) => say((e as Error).message, true));
  };

  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime", hidden: true });
  const drop = h("div", { class: "drop", tabIndex: 0, role: "button" }, h("strong", {}, "Upload an image or screen recording"), h("u", {}, "Or browse files"));
  drop.setAttribute("aria-label", "Upload media");
  drop.onclick = () => file.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = () => drop.classList.remove("over");
  file.onchange = () => { load([...(file.files ?? [])]); file.value = ""; };
  const mediaInfo = h("p", { class: "fine" }, `Recommended ${d.screen.w}×${d.screen.h}. PNG, JPEG, WebP, MP4 or WebM — processed locally.`);
  const fitBtn = h("button", { class: "chip", textContent: "Match clip length to video", disabled: true });
  fitBtn.onclick = () => { if (st.media?.duration) { st.duration = Math.min(60, Math.max(2, Math.round(st.media.duration * 10) / 10)); durIn.value = String(st.duration); durOut.textContent = String(st.duration); dirty = true; syncExportInfo(); } };
  const fitSel = select("Screen fit", [["cover", "Fill screen (crop)"], ["contain", "Fit inside"], ["stretch", "Stretch"]], "cover", (v) => { stage.settings.fit = v as "cover"; stage.applySettings(); dirty = true; });

  // ---------- device ----------
  const cname = h("div", { class: "cname", textContent: d.finishes[0].name });
  const sw = h("div", { class: "swatches" });
  const drawSw = () => {
    cname.textContent = d.finishes[st.finish].name;
    sw.replaceChildren(...d.finishes.map((f, i) => {
      const b = h("button", { class: "dot", title: f.name });
      b.style.setProperty("--c", f.color);
      b.setAttribute("aria-label", f.name);
      b.setAttribute("aria-pressed", String(i === st.finish));
      b.onclick = () => { st.finish = i; stage.setFinish(i); drawSw(); dirty = true; };
      return b;
    }));
  };
  const isHandheld = d.kind === "phone" || d.kind === "tablet";
  const layoutSel = select("Orientation", [["portrait", "Portrait"], ["landscape", "Landscape"]], "portrait", (v) => { stage.settings.landscape = v === "landscape"; stage.applySettings(); dirty = true; });

  // ---------- timeline ----------
  const playBtn = h("button", { class: "chip play", textContent: st.playing ? "Pause" : "Play" });
  const scrub = h("input", { type: "range", min: "0", max: "1000", value: "0", class: "scrub" });
  scrub.setAttribute("aria-label", "Timeline");
  const clock = h("span", { class: "clock", textContent: "0.0 / 8.0 s" });
  const marks = h("div", { class: "marks" });
  const drawMarks = () => {
    marks.replaceChildren(...st.keys.map((k, i) => {
      const m = h("button", { class: "mark", title: `Keyframe ${i + 1}` });
      m.style.left = `${k.t * 100}%`;
      m.setAttribute("aria-pressed", String(i === st.selKey));
      m.setAttribute("aria-label", `Keyframe ${i + 1} at ${(k.t * st.duration).toFixed(1)} seconds`);
      m.onclick = () => { st.selKey = i; setU(k.t, true); drawKeys(); };
      return m;
    }));
  };
  const setPlaying = (p: boolean) => {
    st.playing = p;
    playBtn.textContent = p ? "Pause" : "Play";
    if (videoEl) { if (p) void videoEl.play().catch(() => {}); else videoEl.pause(); }
    if (audioEl) { if (p) void audioEl.play().catch(() => {}); else audioEl.pause(); }
    lastTick = performance.now();
  };
  const setU = (u: number, seekMedia = false) => {
    st.u = Math.min(1, Math.max(0, u));
    scrub.value = String(Math.round(st.u * 1000));
    clock.textContent = `${(st.u * st.duration).toFixed(1)} / ${st.duration.toFixed(1)} s`;
    if (seekMedia) {
      const t = st.u * st.duration;
      if (videoEl && isFinite(videoEl.duration)) videoEl.currentTime = t % videoEl.duration;
      if (audioEl && isFinite(audioEl.duration)) audioEl.currentTime = t % audioEl.duration;
    }
    dirty = true;
  };
  playBtn.onclick = () => setPlaying(!st.playing);
  scrub.oninput = () => { setPlaying(false); setU(Number(scrub.value) / 1000, true); };

  // ---------- animation panel ----------
  const presetSel = select("Camera animation", [...PRESETS.map((p): [string, string] => [p.id, p.name]), ["custom", "Custom keyframes"]], st.preset, (v) => {
    st.preset = v; st.selKey = 0; rebuildKeys(); drawKeys(); setU(0, true);
  });
  const presetHint = h("p", { class: "fine", textContent: PRESETS[0].hint });
  const easeSel = select("Easing", [["", "Easing: per animation"], ...(Object.entries(EASE_LABELS) as [string, string][])], "", (v) => {
    st.easeOverride = v as EaseName;
    if (st.preset === "custom") for (const k of st.keys) if (v) k.ease = v as EaseName;
    rebuildKeys(); drawKeys();
  });
  const durOut = h("span", { class: "val", textContent: String(st.duration) });
  const durIn = h("input", { type: "range", min: "2", max: "60", step: "0.5", value: String(st.duration) });
  durIn.setAttribute("aria-label", "Duration in seconds");
  durIn.oninput = () => { st.duration = Number(durIn.value); durOut.textContent = durIn.value; setU(st.u); syncExportInfo(); };
  const durLabel = labelled("Duration (s)", durIn); durLabel.append(durOut);

  const keyBox = h("div", { class: "keys" });
  const NUMS: { f: keyof Key; label: string; step: number }[] = [
    { f: "yaw", label: "Turn °", step: 1 }, { f: "pitch", label: "Tilt °", step: 1 }, { f: "roll", label: "Roll °", step: 1 },
    { f: "zoom", label: "Zoom ×", step: 0.05 }, { f: "panX", label: "Pan X", step: 0.02 }, { f: "panY", label: "Pan Y", step: 0.02 },
  ];
  const toCustom = () => {
    if (st.preset !== "custom") { st.preset = "custom"; presetSel.value = "custom"; presetHint.textContent = "Edit values below; the camera interpolates between keyframes."; }
  };
  const drawKeys = () => {
    const p = PRESETS.find((x) => x.id === st.preset);
    presetHint.textContent = p ? p.hint : "Edit values below; the camera interpolates between keyframes.";
    keyBox.replaceChildren(...st.keys.map((k, i) => {
      const head = h("div", { class: "khead" });
      const title = h("strong", { textContent: `Keyframe ${i + 1}` });
      const tIn = h("input", { type: "number", min: "0", max: String(st.duration), step: "0.1", value: (k.t * st.duration).toFixed(1) });
      tIn.setAttribute("aria-label", `Keyframe ${i + 1} time in seconds`);
      tIn.oninput = () => {
        if (!tIn.value) return;
        toCustom();
        k.t = Math.min(1, Math.max(0, Number(tIn.value) / st.duration));
        dirty = true;
      };
      tIn.onchange = () => { const sel = st.keys[st.selKey]; st.keys.sort((a, b) => a.t - b.t); st.selKey = st.keys.indexOf(sel); drawKeys(); drawMarks(); };
      const ease = select(`Keyframe ${i + 1} easing`, Object.entries(EASE_LABELS) as [string, string][], k.ease, (v) => { toCustom(); k.ease = v as EaseName; dirty = true; });
      const del = h("button", { class: "rm2", textContent: "×", title: "Delete keyframe", disabled: st.keys.length < 2 });
      del.setAttribute("aria-label", `Delete keyframe ${i + 1}`);
      del.onclick = () => { toCustom(); st.keys.splice(i, 1); st.selKey = Math.max(0, i - 1); drawKeys(); drawMarks(); dirty = true; };
      head.append(title, h("span", { class: "fine" }, "at"), tIn, h("span", { class: "fine" }, "s"), ease, del);
      const grid = h("div", { class: "kgrid" }, ...NUMS.map(({ f, label, step }) => {
        const inp = h("input", { type: "number", step: String(step), value: String(Math.round((k[f] as number) * 1000) / 1000) });
        inp.setAttribute("aria-label", `Keyframe ${i + 1} ${label}`);
        inp.oninput = () => {
          const v = Number(inp.value);
          if (!inp.value || !isFinite(v)) return;
          toCustom();
          (k[f] as number) = f === "zoom" ? Math.max(0.1, v) : v;
          setU(k.t); // jump to the key being edited so the effect is visible
        };
        return h("label", { class: "kf" }, label, inp);
      }));
      const box = h("div", { class: "key" }, head, grid);
      box.setAttribute("aria-current", String(i === st.selKey));
      box.onfocusin = () => { if (st.selKey !== i) { st.selKey = i; drawMarks(); } };
      return box;
    }));
    drawMarks();
  };
  const addKey = h("button", { class: "chip", textContent: "Add keyframe at playhead" });
  addKey.onclick = () => {
    toCustom();
    const pose = evaluate(st.keys, st.u);
    st.keys.push({ ...pose, t: st.u, ease: st.easeOverride || "easeInOut" });
    st.keys.sort((a, b) => a.t - b.t);
    st.selKey = st.keys.findIndex((k) => k.t === st.u);
    drawKeys(); dirty = true;
  };
  const editBtn = h("button", { class: "chip", textContent: "Edit as custom" });
  editBtn.onclick = () => { toCustom(); drawKeys(); };

  // ---------- scene ----------
  const bgRow = h("div", { class: "bgs" });
  const customFrom = h("input", { type: "color", value: "#4facfe" });
  const customTo = h("input", { type: "color", value: "#00f2fe" });
  customFrom.setAttribute("aria-label", "Gradient start color");
  customTo.setAttribute("aria-label", "Gradient end color");
  const setBg = (bg: Bg) => { stage.settings.bg = bg; stage.applySettings(); sizeWrap(); drawBgs(); syncExportInfo(); dirty = true; };
  const bgFile = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", hidden: true });
  bgFile.onchange = async () => {
    const f = bgFile.files?.[0]; bgFile.value = "";
    if (!f) return;
    const img = h("img", { src: URL.createObjectURL(f) });
    try { await img.decode(); setBg({ kind: "image", img }); } catch { say("That background image could not be decoded.", true); }
  };
  const drawBgs = () => {
    const cur = stage.settings.bg;
    const same = (b: Bg) => b.kind !== "image" && JSON.stringify(b) === JSON.stringify(cur);
    const chips = BG_PRESETS.map((p) => {
      const b = h("button", { class: "bgchip", title: p.label });
      if (p.bg.kind === "transparent") b.classList.add("checker"); else b.style.background = bgCss(p.bg);
      b.setAttribute("aria-label", `${p.label} background`);
      b.setAttribute("aria-pressed", String(same(p.bg)));
      b.onclick = () => { if (p.bg.kind === "linear") { customFrom.value = p.bg.from; customTo.value = p.bg.to; } setBg(structuredClone(p.bg)); };
      return b;
    });
    const img = h("button", { class: "bgchip imgchip", title: "Background image", textContent: "🖼" });
    if (cur.kind === "image") img.style.background = bgCss(cur);
    img.setAttribute("aria-label", "Background image");
    img.setAttribute("aria-pressed", String(cur.kind === "image"));
    img.onclick = () => bgFile.click();
    bgRow.replaceChildren(...chips, img);
  };
  const applyCustom = () => setBg({ kind: "linear", from: customFrom.value, to: customTo.value, angle: 135 });
  customFrom.oninput = customTo.oninput = applyCustom;
  const set = <K extends keyof typeof stage.settings>(k: K, v: (typeof stage.settings)[K]) => { stage.settings[k] = v; stage.applySettings(); dirty = true; };
  const lightSel = select("Lighting", [["studio", "Studio"], ["soft", "Soft box"], ["dramatic", "Dramatic"], ["bright", "Bright"]], "studio", (v) => set("light", v as LightPreset));

  // ---------- audio ----------
  const audioIn = h("input", { type: "file", accept: "audio/*", hidden: true });
  const audioName = h("span", { class: "fine", textContent: "No soundtrack" });
  const audioBtn = h("button", { class: "chip", textContent: "Add audio…" });
  audioBtn.onclick = () => audioIn.click();
  const audioClear = h("button", { class: "chip", textContent: "Remove", hidden: true });
  const useVidAudio = h("input", { type: "checkbox", disabled: true });
  useVidAudio.setAttribute("aria-label", "Use the video's own audio");
  const setAudio = (f: File | null) => {
    if (audioEl) { audioEl.pause(); URL.revokeObjectURL(audioEl.src); audioEl = null; }
    st.audioFile = f;
    audioName.textContent = f ? f.name : "No soundtrack";
    audioClear.hidden = !f;
    if (f) {
      audioEl = h("audio", { src: URL.createObjectURL(f), loop: true });
      audioEl.volume = st.volume;
      if (st.playing) void audioEl.play().catch(() => {});
    }
  };
  audioIn.onchange = () => { const f = audioIn.files?.[0]; audioIn.value = ""; if (f) setAudio(f); };
  audioClear.onclick = () => setAudio(null);
  useVidAudio.onchange = () => { st.useVideoAudio = useVidAudio.checked; if (videoEl) videoEl.muted = !st.useVideoAudio; };

  // ---------- export ----------
  const aspectSel = select("Aspect ratio", Object.keys(ASPECTS).map((a): [string, string] => [a, a === "16:9" ? "16:9 · YouTube, web" : a === "9:16" ? "9:16 · Reels, TikTok" : a === "1:1" ? "1:1 · Square" : a === "4:5" ? "4:5 · Feed" : "21:9 · Cinematic"]), st.aspect, (v) => { st.aspect = v; sizeWrap(); resize(); syncExportInfo(); });
  const resSel = select("Resolution", RES.map(([n, v]): [string, string] => [String(v), n]), String(st.res), (v) => { st.res = Number(v); syncExportInfo(); });
  resSel.value = "1920";
  const fpsSel = select("Frame rate", [["24", "24 fps"], ["30", "30 fps"], ["60", "60 fps"]], "30", (v) => { st.fps = Number(v); syncExportInfo(); });
  const fmtSel = select("Format", [["mp4", "MP4 (H.264)"], ["webm", "WebM (VP9)"], ["png", "PNG sequence (ZIP)"]], "mp4", (v) => { st.format = v as "mp4"; syncExportInfo(); });
  const qualSel = select("Quality", [["0.07", "Smaller file"], ["0.12", "Balanced"], ["0.2", "High quality"]], "0.12", (v) => { st.quality = Number(v); });
  const dims = () => {
    const r = ASPECTS[st.aspect];
    const w = r >= 1 ? st.res : Math.round(st.res * r), hh = r >= 1 ? Math.round(st.res / r) : st.res;
    return [w & ~1, hh & ~1] as const;
  };
  const exportInfo = h("p", { class: "fine" });
  /** Transparent output needs a format with alpha: WebM when the browser can encode it, else PNG frames. */
  const effectiveFormat = (): "mp4" | "webm" | "png" => st.format;
    return st.alphaWebm ? "webm" : "png";
  };
  function syncExportInfo() {
    const transparent = stage.settings.bg.kind === "transparent";
    const f = effectiveFormat();
    const [w, hh] = dims();
    const frames = Math.round(st.duration * st.fps);
    const label = f === "png" ? "PNG sequence in a ZIP" : f === "webm" ? "WebM" : "MP4";
    const note = transparent ? (f === "png" && st.format !== "png" ? " · this browser cannot write transparent video, so frames are exported as transparent PNGs" : " · transparent") : "";
    exportInfo.textContent = `${w}×${hh} · ${frames} frames · ${label}${note}${f === "png" && frames > MAX_PNG_FRAMES ? ` · over the ${MAX_PNG_FRAMES}-frame limit` : ""}`;
  }
  void alphaWebmSupported().then((ok) => { st.alphaWebm = ok; syncExportInfo(); });
  const bar = h("progress", { max: 1, value: 0, hidden: true });
  const cancel = h("button", { class: "chip", textContent: "Cancel", hidden: true });
  cancel.onclick = () => abort?.abort();
  const gen = h("button", { class: "primary", textContent: "Render video" });
  if (!webCodecsSupported()) { gen.disabled = true; say("Video export needs WebCodecs (Chrome, Edge or Safari 16.4+). The live preview still works.", true); }
  gen.onclick = async () => {
    if (exporting) return;
    exporting = true; abort = new AbortController();
    const wasPlaying = st.playing;
    setPlaying(false);
    gen.disabled = true; bar.hidden = false; cancel.hidden = false; bar.value = 0;
    const [w, hh] = dims();
    const transparent = stage.settings.bg.kind === "transparent";
    const format = effectiveFormat();
    const restore = stage.enterExport(w, hh);
    const audioSrc = st.audioFile ?? (st.useVideoAudio && st.media?.kind === "video" ? st.media.file : null);
    const t0 = performance.now();
    try {
      const res = await exportVideo({
        canvas, width: w, height: hh, fps: st.fps, duration: st.duration, format, alpha: transparent && format !== "mp4", quality: st.quality,
        audio: audioSrc ? { file: audioSrc, volume: st.volume, fadeOut: st.fadeOut } : undefined,
        signal: abort.signal,
        renderFrame: async (_i, t) => {
          if (videoEl && isFinite(videoEl.duration)) await seek(videoEl, t % videoEl.duration);
          st.u = t / st.duration;
          drawNow();
        },
        onProgress: (n, total) => { bar.value = n / total; say(`Rendering frame ${n} of ${total}…`); },
      });
      const a = h("a", { href: URL.createObjectURL(res.blob), download: format === "png" ? `${d.id}-mockup-frames.zip` : `${d.id}-mockup.${format}` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      say(`Done: ${w}×${hh} ${format === "png" ? "PNG sequence" : format.toUpperCase()}, ${(res.blob.size / 1048576).toFixed(1)} MB in ${((performance.now() - t0) / 1000).toFixed(0)} s.${res.audioSkipped ? ` Audio skipped: ${res.audioSkipped}` : ""}`, !!res.audioSkipped);
    } catch (e) {
      const err = e as Error;
      say(err.name === "AbortError" ? "Export cancelled." : err.message, err.name !== "AbortError");
    } finally {
      restore();
      exporting = false; abort = null;
      gen.disabled = false; bar.hidden = true; cancel.hidden = true;
      st.u = 0; setU(0, true);
      if (wasPlaying) setPlaying(true);
      resize();
    }
  };

  // ---------- assemble ----------
  const side = h("div", { class: "side" },
    card("Screen media", drop, file, mediaInfo, h("div", { class: "row tight" }, fitSel, fitBtn)),
    card("Device", cname, sw, isHandheld ? h("div", { class: "row tight" }, layoutSel) : h("span"),
      slider("Screen gloss", 0, 1, 0.05, DEFAULT_SETTINGS.glare, (v) => set("glare", v))),
    card("Camera animation", presetSel, presetHint, durLabel, easeSel,
      slider("Idle float", 0, 1, 0.05, DEFAULT_SETTINGS.float, (v) => set("float", v)),
      slider("Field of view", 12, 60, 1, DEFAULT_SETTINGS.fov, (v) => set("fov", v)),
      h("div", { class: "row tight" }, editBtn, addKey), keyBox),
    card("Scene", bgRow,
      h("div", { class: "row tight" }, h("span", { class: "fine" }, "Custom gradient"), customFrom, customTo),
      bgFile, h("div", { class: "row" }, lightSel),
      slider("Ground shadow", 0, 1, 0.05, stage.settings.shadow, (v) => set("shadow", v)),
      slider("Reflections", 0, 2, 0.05, 1, (v) => set("envIntensity", v)),
      slider("Exposure", 0.4, 1.8, 0.05, 1, (v) => set("exposure", v))),
    card("Audio", h("div", { class: "row tight" }, audioBtn, audioClear, audioName), audioIn,
      h("label", { class: "fine range" }, useVidAudio, "Use the screen video's own sound"),
      slider("Volume", 0, 1, 0.05, 1, (v) => { st.volume = v; if (audioEl) audioEl.volume = v; }),
      slider("Fade out (s)", 0, 5, 0.5, 1, (v) => { st.fadeOut = v; })),
    card("Export", h("div", { class: "row" }, aspectSel, resSel, fpsSel), h("div", { class: "row tight" }, fmtSel, qualSel), exportInfo,
      gen, bar, cancel, status));

  const timeline = h("div", { class: "timeline" }, playBtn, h("div", { class: "track" }, scrub, marks), clock);
  const stageCol = h("div", { class: "vcol" }, stageCard, timeline);
  const el = h("div", {}, h("a", { href: `/model/${d.id}/`, class: "back", textContent: `← ${d.name} stills` }),
    h("h1", {}, `${d.name} video mockup`),
    h("p", { class: "sub" }, "Live 3D preview in WebGL. Pick a camera move, add your screen recording, render an MP4 or transparent WebM — all in this tab."),
    h("div", { class: "layout" }, stageCol, side));

  // ---------- run ----------
  stageCard.ondragover = (e) => e.preventDefault();
  sizeWrap(); drawSw(); drawBgs(); rebuildKeys(); drawKeys(); syncExportInfo();
  let lastTick = performance.now();
  let raf = 0;
  const loop = (now: number) => {
    raf = requestAnimationFrame(loop);
    if (exporting) return;
    if (st.playing) {
      const dt = (now - lastTick) / 1000;
      const u = st.u + dt / st.duration;
      if (u >= 1) {
        setU(0, true);
        if (videoEl && st.playing) void videoEl.play().catch(() => {});
      } else setU(u);
    }
    lastTick = now;
    if (st.playing || dirty) { dirty = false; drawNow(); }
  };
  raf = requestAnimationFrame(loop);
  const onVis = () => { if (document.hidden) setPlaying(false); };
  document.addEventListener("visibilitychange", onVis);

  return {
    el, load,
    dispose() {
      cancelAnimationFrame(raf);
      abort?.abort();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVis);
      clearMedia();
      setAudio(null);
      stage.dispose();
    },
  };
}

function seek(v: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(v.currentTime - t) < 1e-3 && v.readyState >= 2) return Promise.resolve();
  return new Promise((ok) => {
    const done = () => { v.removeEventListener("seeked", done); clearTimeout(timer); ok(); };
    const timer = setTimeout(done, 4000);
    v.addEventListener("seeked", done);
    v.currentTime = t;
  });
}
