import "./style.css";
import devicesJson from "../../core/devices.json";
import { zip } from "./zip";
import { dropImage, importImage, render, renderEncoded, Superseded, type Rendered } from "./engine";

type Source = { field: string; status: "fetched" | "derived" | "estimated" | "generic"; url?: string; note?: string };
type Device = {
  id: string; brand: string; name: string; category: string; year: number; kind: "phone" | "tablet" | "laptop" | "imac";
  body: { w: number; h: number; d: number };
  stand?: { total_h: number };
  screen: { w: number; h: number; diag_in: number };
  finishes: { name: string; color: string }[];
  orientations: string[];
  sources: Source[];
};
const devices = devicesJson.devices as unknown as Device[];
const FITS = ["cover", "contain", "stretch"] as const;
const app = document.getElementById("app")!;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { class?: string } = {}, ...kids: (Node | string)[]) => {
  const { class: cls, ...rest } = props as Record<string, unknown>;
  const n = Object.assign(document.createElement(tag), rest);
  if (cls) n.className = cls as string;
  n.append(...kids);
  return n;
};

function paint(canvas: HTMLCanvasElement, r: Rendered) {
  canvas.width = r.width;
  canvas.height = r.height;
  canvas.getContext("2d")!.putImageData(r.data, 0, 0);
}

function shell(content: HTMLElement) {
  app.replaceChildren(
    el("header", { class: "top" },
      el("a", { class: "brand", href: "/" }, "Mockup"),
      el("span", { class: "note" }, "Rendered locally with Rust + WebAssembly · nothing is uploaded")),
    el("main", {}, content),
    el("footer", {}, "3D models are original, built from published dimensions (sources and estimated values are listed on each device page). Not manufacturer assets; product names are used descriptively."),
  );
}

// ---------- Home ----------
function home() {
  let query = "", cat = "All";
  const cats = ["All", ...new Set(devices.map((d) => d.category))];
  const grid = el("div", { class: "grid" });
  const draw = () => {
    grid.replaceChildren();
    for (const d of devices) {
      if (cat !== "All" && d.category !== cat) continue;
      if (query && !`${d.brand} ${d.name} ${d.category}`.toLowerCase().includes(query)) continue;
      const canvas = el("canvas");
      render({ deviceId: d.id, finish: 0, orientation: d.orientations.includes("left") && d.kind !== "phone" && d.kind !== "tablet" ? "left" : d.orientations[0], fit: "cover", maxSide: 340, native: true, imageId: null })
        .then((r) => paint(canvas, r));
      grid.append(el("a", { class: "card", href: `/model/${d.id}/` }, canvas,
        el("div", { class: "n" }, d.name), el("div", { class: "m" }, `${d.brand}${d.year ? ` · ${d.year}` : ""}`)));
    }
    if (!grid.children.length) grid.append(el("p", { class: "sub" }, "No devices match."));
  };
  const chips = el("div", { class: "row" });
  const drawChips = () => chips.replaceChildren(...cats.map((c) => {
    const b = el("button", { class: "chip", textContent: c });
    b.setAttribute("aria-pressed", String(c === cat));
    b.onclick = () => { cat = c; drawChips(); draw(); };
    return b;
  }));
  const search = el("input", { type: "search", placeholder: "Search devices…" });
  search.setAttribute("aria-label", "Search devices");
  search.oninput = () => { query = search.value.trim().toLowerCase(); draw(); };
  drawChips(); draw();
  shell(el("div", {}, el("h1", {}, "Device mockups"), el("p", { class: "sub" }, "Pick a device, drop a screenshot, download the mockup."),
    el("div", { class: "tools" }, search), chips, el("div", { class: "gap" }), grid));
}

// ---------- Device page ----------
const ICONS: Record<string, string> = {
  portrait: '<svg viewBox="0 0 48 48"><rect x="16" y="6" width="16" height="36" rx="1.5"/></svg>',
  landscape: '<svg viewBox="0 0 48 48"><rect x="6" y="16" width="36" height="16" rx="1.5"/></svg>',
  right: '<svg viewBox="0 0 48 48"><path d="M8 17 28 6l10 5 2 20-20 11-10-5z M20 42V22L8 17 M20 22l20-11"/></svg>',
  left: '<svg viewBox="0 0 48 48"><path d="M40 17 20 6 10 11 8 31l20 11 10-5z M28 42V22l12-5 M28 22 8 11"/></svg>',
};
ICONS.front = '<svg viewBox="0 0 48 48"><rect x="10" y="10" width="28" height="19" rx="1.5"/><path d="M6 33h36l-3 5H9z"/></svg>';
const CLOUD = '<svg viewBox="0 0 48 48" width="44" height="44"><path d="M14 34a8 8 0 0 1-1-15.9A11 11 0 0 1 34 16a9 9 0 0 1 1 18 M24 40V24 M18 29l6-6 6 6"/></svg>';

type Shot = { id: number; w: number; h: number; url: string; name: string };

function specs(d: Device): HTMLElement {
  const b = d.body;
  const dims = d.kind === "laptop" ? `${b.w} × ${b.h} × ${b.d} mm (closed)` : d.kind === "imac" ? `${b.w} mm wide, ${d.stand?.total_h} mm tall with stand` : `${b.w} × ${b.h} × ${b.d} mm`;
  const est = d.sources.filter((x) => x.status === "estimated").map((x) => x.field);
  const fetched = d.sources.filter((x) => x.status === "fetched");
  const rows: (Node | string)[] = [
    el("p", { class: "fine" }, `Real dimensions: ${dims}. Screen ${d.screen.diag_in}″, ${d.screen.w}×${d.screen.h} px.`),
  ];
  if (d.sources.some((x) => x.status === "generic")) rows.push(el("p", { class: "fine" }, "Original generic design, not a specific commercial model."));
  else {
    rows.push(el("p", { class: "fine" }, "Sources: ", ...[...new Set(fetched.map((x) => x.url!))].flatMap((u) => [el("a", { href: u, target: "_blank", rel: "noopener noreferrer", textContent: new URL(u).hostname }), " "])));
    if (est.length) rows.push(el("p", { class: "fine" }, `Estimated (not published): ${est.join(", ")}.`));
  }
  return el("section", { class: "pcard" }, el("h2", {}, "Specifications"), ...rows);
}

function devicePage(d: Device) {
  document.title = `${d.name} mockup – Mockup`;
  const st = {
    finish: 0, fit: "cover" as string, view: d.orientations[0],
    shots: [] as Shot[], active: -1,
  };
  let token = 0;

  const preview = el("canvas");
  const hint = el("div", { class: "hint" }, "Upload", el("br"), "Image Here");
  const stage = el("div", { class: "stagecard" }, el("div", { class: "stagewrap" }, preview, hint));
  const status = el("div", { class: "status" });
  const say = (msg: string, err = false) => { status.textContent = msg; status.className = "status" + (err ? " err" : ""); };

  const file = el("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true, hidden: true });
  const drop = el("div", { class: "drop", tabIndex: 0, role: "button" });
  drop.setAttribute("aria-label", "Upload screenshots");
  const dropIcon = el("div", { class: "cloud" }); dropIcon.innerHTML = CLOUD;
  drop.append(dropIcon, el("strong", {}, "Upload your images here"), el("u", {}, "Or browse files"));
  const hintTxt = el("p", { class: "fine" }, `Recommend size ${d.screen.w}px * ${d.screen.h}px, We support jpg, png and webp`);
  const list = el("div", { class: "shots" });

  const drawList = () => {
    list.replaceChildren(...st.shots.map((s, i) => {
      const img = el("img", { src: s.url, alt: s.name });
      const rm = el("button", { class: "rm", textContent: "×", title: "Remove" });
      rm.setAttribute("aria-label", `Remove ${s.name}`);
      rm.onclick = (e) => {
        e.stopPropagation();
        dropImage(s.id); URL.revokeObjectURL(s.url);
        st.shots.splice(i, 1);
        st.active = Math.min(st.active, st.shots.length - 1);
        drawList(); refresh();
      };
      const b = el("div", { class: "shot" }, img, rm);
      b.setAttribute("aria-pressed", String(i === st.active));
      b.onclick = () => { st.active = i; drawList(); refresh(); };
      return b;
    }));
    gen.disabled = busy || !st.shots.length;
    gen.textContent = st.shots.length ? `Generate ${st.shots.length * d.orientations.length} product mockups` : "Generate product mockups";
  };

  const load = async (files: File[]) => {
    if (!files.length) return;
    const errors: string[] = [];
    for (const [i, f] of files.entries()) {
      say(`Reading image ${i + 1} of ${files.length}…`);
      try {
        const img = await importImage(f);
        st.shots.push({ ...img, name: f.name });
        st.active = st.shots.length - 1;
      } catch (e) { errors.push(`${f.name}: ${(e as Error).message}`); }
    }
    say(errors.join(" "), errors.length > 0);
    drawList(); refresh();
  };
  drop.onclick = () => file.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); file.click(); } };
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
  drop.ondragleave = () => drop.classList.remove("over");
  drop.ondrop = () => drop.classList.remove("over");
  file.onchange = () => { void load([...(file.files ?? [])]); file.value = ""; };

  // Color
  const colorName = el("div", { class: "cname" });
  const sw = el("div", { class: "swatches" });
  const drawSw = () => {
    colorName.textContent = d.finishes[st.finish].name;
    sw.replaceChildren(...d.finishes.map((f, i) => {
      const b = el("button", { class: "dot", title: f.name });
      b.style.setProperty("--c", f.color);
      b.setAttribute("aria-label", f.name);
      b.setAttribute("aria-pressed", String(i === st.finish));
      b.onclick = () => { st.finish = i; drawSw(); refresh(); };
      return b;
    }));
  };

  // Orientation icons choose the previewed view; Generate always exports every orientation.
  const ori = el("div", { class: "orients" });
  const drawOri = () => ori.replaceChildren(...d.orientations.map((o) => {
    const b = el("button", { class: "ori", title: o });
    b.innerHTML = ICONS[o];
    b.setAttribute("aria-label", `Preview ${o} orientation`);
    b.setAttribute("aria-pressed", String(st.view === o));
    b.onclick = () => { st.view = o; drawOri(); refresh(); };
    return b;
  }));

  const fit = el("select", {});
  fit.setAttribute("aria-label", "Screenshot fit");
  for (const f of FITS) fit.append(el("option", { value: f, textContent: f === "cover" ? "Fill screen (crop)" : f === "contain" ? "Fit inside" : "Stretch" }));
  fit.onchange = () => { st.fit = fit.value; refresh(); };
  const fmt = el("select", {});
  fmt.setAttribute("aria-label", "Format");
  for (const [v, t] of [["image/png", "PNG (transparent)"], ["image/webp", "WebP"], ["image/jpeg", "JPEG"]]) fmt.append(el("option", { value: v, textContent: t }));
  const quality = el("select", {});
  quality.setAttribute("aria-label", "Resolution");
  for (const [v, t] of [["4096", "Large (up to 4096 px)"], ["2048", "Medium (2048 px)"], ["1024", "Small (1024 px)"]]) quality.append(el("option", { value: v, textContent: t }));

  const refresh = () => {
    const my = ++token;
    const cur = st.shots[st.active];
    hint.style.display = cur || st.view !== "portrait" ? "none" : "";
    render({ key: "preview", deviceId: d.id, finish: st.finish, orientation: st.view, fit: st.fit, maxSide: 1000, native: true, imageId: cur?.id ?? null })
      .then((r) => { if (my === token) paint(preview, r); }).catch((e) => { if (!(e instanceof Superseded)) say(e.message, true); });
  };

  let busy = false;
  const gen = el("button", { class: "primary", textContent: "Generate product mockups" });
  gen.disabled = true;
  gen.onclick = async () => {
    busy = true; gen.disabled = true;
    const type = fmt.value as "image/png";
    const ext = type.split("/")[1].replace("jpeg", "jpg");
    const files: { name: string; data: Uint8Array }[] = [];
    const bases = new Map<number, string>();
    for (const s of st.shots) {
      const raw = s.name.replace(/\.[^.]*$/, "").replace(/[^\w.-]+/g, "_").slice(0, 60) || "screenshot";
      let b = raw;
      for (let n = 2; [...bases.values()].includes(b); n++) b = `${raw}-${n}`;
      bases.set(s.id, b);
    }
    const jobs = st.shots.flatMap((s) => d.orientations.map((o) => ({ s, o })));
    try {
      let done = 0;
      say(`Generating 0 of ${jobs.length}…`);
      const results = await Promise.all(jobs.map(async ({ s, o }) => {
        const r = await renderEncoded({ deviceId: d.id, finish: st.finish, orientation: o, fit: st.fit, maxSide: Number(quality.value), native: true, imageId: s.id }, type);
        say(`Generating ${++done} of ${jobs.length}…`);
        console.debug(`[mockup] ${d.id} ${o}: ${r.width}x${r.height}, render ${r.ms.toFixed(0)} ms`);
        return { name: `${bases.get(s.id)}-${d.id}-${o}.${ext}`, data: new Uint8Array(await r.blob.arrayBuffer()) };
      }));
      files.push(...results);
      const blob = zip(files);
      const a = el("a", { href: URL.createObjectURL(blob), download: `${d.id}-mockups.zip` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      say(`Done: ${files.length} mockups in one zip (${(blob.size / 1024).toFixed(0)} KB).`);
    } catch (e) { say((e as Error).message, true); }
    busy = false; drawList();
  };

  const card = (title: string, ...kids: (Node | string)[]) => el("section", { class: "pcard" }, el("h2", {}, title), ...kids);
  const panel = el("div", { class: "side" },
    card("File upload", drop, file, hintTxt, list),
    el("section", { class: "pcard" }, el("h2", {}, "Color"), colorName, sw, gen, status),
    card("Device orientations", ori),
    card("Options", el("div", { class: "row" }, fit, fmt, quality)),
    specs(d));
  shell(el("div", {}, el("a", { href: "/", class: "back", textContent: "← All devices" }),
    el("div", { class: "layout" }, stage, panel)));
  drawSw(); drawOri(); drawList(); refresh();
  currentLoad = (fs) => void load(fs);
}

// ---------- Global: drop-anywhere, paste, routing ----------
const overlay = el("div", { class: "fullDrop" }, "Drop your screenshot anywhere");
document.body.append(overlay);
let currentLoad: ((f: File[]) => void) | null = null;
const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
let depth = 0;
window.addEventListener("dragenter", (e) => { if (currentLoad && hasFiles(e)) { depth++; overlay.classList.add("on"); } });
window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; overlay.classList.remove("on"); } });
window.addEventListener("dragover", (e) => { if (currentLoad) e.preventDefault(); });
window.addEventListener("drop", (e) => { depth = 0; overlay.classList.remove("on"); if (!currentLoad) return; e.preventDefault(); currentLoad([...(e.dataTransfer?.files ?? [])]); });
window.addEventListener("paste", (e) => {
  const fs = [...(e.clipboardData?.files ?? [])].filter((x) => x.type.startsWith("image/"));
  if (fs.length && currentLoad) currentLoad(fs);
});

function route() {
  const m = location.pathname.match(/^\/model\/([\w-]+)\/?$/);
  const d = m && devices.find((x) => x.id === m[1]);
  currentLoad = null;
  document.title = "Mockup – device mockups in your browser";
  window.scrollTo(0, 0);
  if (d) {
    devicePage(d);
  } else if (m) {
    shell(el("div", {}, el("h1", {}, "Device not found"), el("a", { href: "/" }, "Back to all devices")));
  } else home();
}
document.addEventListener("click", (e) => {
  const a = (e.target as Element).closest("a");
  if (a && a.origin === location.origin && !a.hasAttribute("download") && !e.metaKey && !e.ctrlKey && e.button === 0) {
    e.preventDefault(); history.pushState(null, "", a.href); route();
  }
});
window.addEventListener("popstate", route);
route();
