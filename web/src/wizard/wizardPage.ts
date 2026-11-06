// Guided studio: upload raw screenshots once, see them in the chosen device, pick which go to the video and the
// store listing (the strongest, most distinct ones are pre-selected), then continue to the video and store studios.
import { render, renderEncoded } from "../engine";
import { library, type LibShot } from "../library";
import { zip } from "../zip";

export type WizardDevice = { id: string; brand: string; name: string; kind: string; orientations: string[]; finishes: { name: string; color: string }[] };

type Props<K extends keyof HTMLElementTagNameMap> = Partial<HTMLElementTagNameMap[K]> & { class?: string };
const h = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Props<K> = {}, ...kids: (Node | string)[]) => {
  const { class: cls, ...rest } = props as Record<string, unknown>;
  const n = Object.assign(document.createElement(tag), rest);
  if (cls) n.className = cls as string;
  n.append(...kids);
  return n;
};
const card = (title: string, ...kids: (Node | string)[]) => h("section", { class: "pcard" }, h("h2", {}, title), ...kids);

export function wizardPage(devices: WizardDevice[]): { el: HTMLElement; load: (files: File[]) => void; dispose: () => void } {
  const screens = devices.filter((d) => d.kind === "phone" || d.kind === "tablet");
  if (!screens.some((d) => d.id === library.deviceId)) library.deviceId = (screens.find((d) => d.id === "iphone-15-pro") ?? screens[0]).id;
  const dev = () => screens.find((d) => d.id === library.deviceId)!;
  let alive = true;

  // ---------- 1 · upload ----------
  const devSel = h("select");
  devSel.setAttribute("aria-label", "Device for the mockups");
  for (const d of screens) devSel.append(h("option", { value: d.id, textContent: `${d.brand} ${d.name}` }));
  devSel.value = library.deviceId;
  const finSel = h("select");
  finSel.setAttribute("aria-label", "Device colour");
  const fillFinish = () => {
    finSel.replaceChildren(...dev().finishes.map((f, k) => h("option", { value: String(k), textContent: f.name })));
    if (library.finish >= dev().finishes.length) library.finish = 0;
    finSel.value = String(library.finish);
  };
  fillFinish();
  devSel.onchange = () => { library.deviceId = devSel.value; library.deviceChosen = true; fillFinish(); drawGrid(); };
  finSel.onchange = () => { library.finish = Number(finSel.value); library.deviceChosen = true; drawGrid(); };

  const msg = h("p", { class: "status", role: "status" });
  const fileIn = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", multiple: true, hidden: true });
  fileIn.setAttribute("aria-label", "Add screenshots");
  const mockIn = h("input", { type: "file", accept: "image/png,image/webp", multiple: true, hidden: true });
  mockIn.setAttribute("aria-label", "Add finished mockups");
  const add = async (files: File[], framed?: boolean) => {
    msg.textContent = "Reading screenshots…"; msg.classList.remove("bad");
    const errs = await library.add(files, framed === undefined ? {} : { framed });
    msg.textContent = errs.join(" "); msg.classList.toggle("bad", errs.length > 0);
  };
  const drop = h("div", { class: "drop", tabIndex: 0 }, h("strong", {}, "Add your raw app screenshots"),
    h("br"), h("small", {}, "PNG, JPEG or WebP · up to 24 · drop, paste or click · transparent PNGs are recognised as finished mockups"));
  drop.onclick = () => fileIn.click();
  drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileIn.click(); } };
  fileIn.onchange = () => { void add([...(fileIn.files ?? [])]); fileIn.value = ""; };
  const mockBtn = h("button", { class: "chip", textContent: "Add finished mockups…" });
  mockBtn.onclick = () => mockIn.click();
  mockIn.onchange = () => { void add([...(mockIn.files ?? [])], true); mockIn.value = ""; };

  // ---------- 2 · review ----------
  const grid = h("div", { class: "wgrid" });
  const summary = h("p", { class: "fine" });
  const previews = new Map<string, Promise<ImageData>>();
  const rendered = (s: LibShot) => {
    const key = `${s.id}|${library.deviceId}|${library.finish}`;
    let p = previews.get(key);
    if (!p) {
      p = render({ deviceId: library.deviceId, finish: library.finish, orientation: s.w > s.h ? "landscape" : "portrait", fit: "cover", maxSide: 560, native: true, imageId: s.id }).then((r) => r.data);
      previews.set(key, p);
      p.catch(() => previews.delete(key));
    }
    return p;
  };

  function drawGrid() {
    const shots = library.shots;
    grid.replaceChildren(...shots.map((s, k) => {
      const view = h("div", { class: "wview" });
      if (s.framed) view.append(Object.assign(new Image(), { src: s.url, alt: s.name }));
      else {
        const cv = h("canvas");
        view.append(cv);
        void rendered(s).then((d) => { if (!alive) return; cv.width = d.width; cv.height = d.height; cv.getContext("2d")!.putImageData(d, 0, 0); }).catch(() => { view.textContent = "Could not render"; });
      }
      const badges = h("div", { class: "badges" });
      if (s.suggestVideo || s.suggestStore) badges.append(h("span", { class: "badge good", textContent: "★ Suggested" }));
      if (s.dup) badges.append(h("span", { class: "badge", textContent: "Similar to another" }));
      if (s.blank) badges.append(h("span", { class: "badge warn", textContent: "Looks empty" }));
      if (s.framed) badges.append(h("span", { class: "badge", textContent: "Finished mockup" }));
      const toggle = (label: string, on: boolean, fn: (v: boolean) => void, disabled = false, title = "") => {
        const b = h("button", { class: "chip", textContent: label, disabled, title });
        b.setAttribute("aria-pressed", String(on));
        b.onclick = () => fn(!on);
        return b;
      };
      const rm = h("button", { class: "rm2", textContent: "×", title: "Remove" });
      rm.setAttribute("aria-label", `Remove ${s.name}`);
      rm.onclick = () => { library.remove(s.id); };
      return h("div", { class: "witem" }, view, h("div", { class: "wname", title: s.name }, `${k + 1}. ${s.name}`), badges,
        h("div", { class: "wtoggles" },
          toggle("🎬 Video", s.video, (v) => library.set(s.id, { video: v }), s.framed, s.framed ? "A finished mockup can't go on a 3D device" : "Show this screen in the video mockup"),
          toggle("🛍️ Store", s.store, (v) => library.set(s.id, { store: v }), false, "Use in the App Store / Play listing"),
          toggle("Finished mockup", s.framed, (v) => library.set(s.id, { framed: v }), false, "This image already has a device frame: use it as it is"),
          rm));
    }));
    if (!shots.length) grid.append(h("p", { class: "sub" }, "Nothing yet. Add some screenshots above."));
    const nv = library.get("video").length, ns = library.get("store").length;
    summary.textContent = shots.length ? `${shots.length} screenshots · ${nv} for the video · ${ns} for the store listing (Google Play shows up to 8, the App Store up to 10).` : "";
    nextCard.style.display = shots.length ? "" : "none";
    vidLink.setAttribute("href", `/video/${library.deviceId}/`);
    vidLink.classList.toggle("disabled", nv === 0);
    storeLink.classList.toggle("disabled", ns === 0);
  }
  const unsub = library.on(drawGrid);

  const resuggest = h("button", { class: "chip", textContent: "↺ Re-suggest the best" });
  resuggest.onclick = () => library.resetPicks();
  const allStore = h("button", { class: "chip", textContent: "All → store" });
  allStore.onclick = () => { for (const s of library.shots) library.set(s.id, { store: true }); };
  const noVideo = h("button", { class: "chip", textContent: "Clear video" });
  noVideo.onclick = () => { for (const s of library.shots) library.set(s.id, { video: false }); };

  // ---------- 3 · continue ----------
  const status = h("p", { class: "status", role: "status" });
  const vidLink = h("a", { class: "bigbtn", href: "/video/" }, h("strong", {}, "🎬 Make the video →"), h("span", {}, "Your video screens play on a 3D device"));
  const storeLink = h("a", { class: "bigbtn", href: "/store/" }, h("strong", {}, "🛍️ Build the store listing →"), h("span", {}, "Carousel screenshots, feature graphic and text"));
  const zipBtn = h("button", { class: "chip", textContent: "Download all mockups (ZIP)" });
  zipBtn.onclick = async () => {
    const list = library.shots.filter((s) => !s.framed);
    if (!list.length) return;
    zipBtn.disabled = true;
    try {
      const files: { name: string; data: Uint8Array }[] = [];
      for (const [k, s] of list.entries()) {
        status.textContent = `Rendering ${k + 1} of ${list.length}…`; status.classList.remove("bad");
        const r = await renderEncoded({ deviceId: library.deviceId, finish: library.finish, orientation: s.w > s.h ? "landscape" : "portrait", fit: "cover", maxSide: 2400, native: true, imageId: s.id }, "image/png");
        files.push({ name: `mockup-${String(k + 1).padStart(2, "0")}-${s.name.replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "-")}.png`, data: new Uint8Array(await r.blob.arrayBuffer()) });
      }
      const a = h("a", { href: URL.createObjectURL(zip(files)), download: `${dev().id}-mockups.zip` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      status.textContent = `Done: ${files.length} mockups.`;
    } catch (e) { status.textContent = (e as Error).message; status.classList.add("bad"); }
    finally { zipBtn.disabled = false; }
  };
  const nextCard = card("3 · Continue", h("div", { class: "bigbtns" }, vidLink, storeLink), h("div", { class: "row tight" }, zipBtn), status,
    h("p", { class: "fine" }, "Your choices carry over: the video studio shows the video screens on the device, and the store listing starts with the store screens. You can change them any time here."));

  const el = h("div", {},
    h("h1", {}, "Guided studio"),
    h("p", { class: "sub" }, "Upload raw screenshots once. They are placed in a device, the most distinct ones are suggested for the video and the store, and you decide what goes where."),
    card("1 · Add screenshots", h("div", { class: "row" }, devSel, finSel), drop, fileIn, mockIn, h("div", { class: "row tight" }, mockBtn), msg),
    card("2 · Choose what goes where", h("div", { class: "row tight" }, resuggest, allStore, noVideo), summary, grid),
    nextCard);
  drawGrid();
  return {
    el,
    load: (files) => void add(files),
    dispose() { alive = false; unsub(); },
  };
}
