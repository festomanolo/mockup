// End-to-end check in real Chrome: preview renders, 2 screenshots upload, Generate yields one zip
// containing every orientation per image, with filenames ending in the orientation name.
import puppeteer from "puppeteer-core";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5188;
const out = mkdtempSync(join(tmpdir(), "mockup-e2e-"));
const device = process.env.DEVICE ?? "galaxy-s24-ultra";
const expected = (process.env.ORIENTS ?? "portrait,landscape,right,left").split(",");

function png(w, h, [r, g, b]) {
  const crc = (buf) => { let c = ~0; for (const x of buf) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return ~c >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const a = join(out, "shot one.png"), b = join(out, "second.png");
writeFileSync(a, png(300, 650, [220, 40, 40])); writeFileSync(b, png(300, 650, [40, 90, 220]));

const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: join(root, "web"), stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--no-sandbox"] });
let failed = false;
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.setViewport({ width: 1400, height: 1000 });
  const cdp = await page.createCDPSession();
  await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: out });
  await page.goto(`http://localhost:${port}/model/${device}/`);
  await page.waitForFunction(() => { const c = document.querySelector(".stagewrap canvas"); return c && c.width > 10; }, { timeout: 15000 });
  await page.screenshot({ path: join(out, "01-empty.png") });
  const input = await page.$("input[type=file]");
  await input.uploadFile(a, b);
  await page.waitForFunction(() => document.querySelectorAll(".shot").length === 2, { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot({ path: join(out, "02-two-shots.png") });
  console.log("shots:", out);
  const t0 = Date.now();
  // drag-and-drop anywhere on the page (two files) and paste (one file) must add thumbnails
  const dataUrl = "data:image/png;base64," + png(120, 260, [30, 160, 90]).toString("base64");
  await page.evaluate(async (url) => {
    const blob = await (await fetch(url)).blob();
    const mk = (n) => new File([blob], n, { type: "image/png" });
    const dt = new DataTransfer(); dt.items.add(mk("dropped-a.png")); dt.items.add(mk("dropped-b.png"));
    for (const t of ["dragenter", "dragover", "drop"]) document.body.dispatchEvent(new DragEvent(t, { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, dataUrl);
  await page.waitForFunction(() => document.querySelectorAll(".shot").length === 4, { timeout: 15000 });
  await page.evaluate(async (url) => {
    const blob = await (await fetch(url)).blob();
    const dt = new DataTransfer(); dt.items.add(new File([blob], "pasted.png", { type: "image/png" }));
    window.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, dataUrl);
  await page.waitForFunction(() => document.querySelectorAll(".shot").length === 5, { timeout: 15000 });
  console.log("drag-and-drop (2 files) and paste (1 file) added thumbnails: 2 -> 4 -> 5");
  // remove the three extra shots again so the zip check stays about the two uploaded files
  for (let i = 0; i < 3; i++) await page.click(".shot:last-child .rm");
  await page.waitForFunction(() => document.querySelectorAll(".shot").length === 2, { timeout: 15000 });
  await page.click("button.primary");
  await page.waitForFunction(() => /Done:/.test(document.querySelector(".status")?.textContent ?? ""), { timeout: 120000 });
  console.log(`generate: ${((Date.now() - t0) / 1000).toFixed(1)} s for ${2 * expected.length} mockups`);
  await new Promise((r) => setTimeout(r, 1000));
  const zipName = readdirSync(out).find((f) => f.endsWith(".zip"));
  if (!zipName) throw new Error("no zip downloaded");
  const list = execFileSync("unzip", ["-Z1", join(out, zipName)]).toString().trim().split("\n");
  console.log(list.join("\n"));
  const want = ["shot_one", "second"].flatMap((base) => expected.map((o) => `${base}-${device}-${o}.png`)).sort();
  if (JSON.stringify([...list].sort()) !== JSON.stringify(want)) throw new Error("zip contents differ from expected: " + want.join(", "));
  execFileSync("unzip", ["-tq", join(out, zipName)], { stdio: "inherit" });
  // inspect one exported PNG: with a background the corner is opaque, otherwise it is transparent with a soft shadow
  const first = list.find((n) => n.startsWith("second-"));
  execFileSync("unzip", ["-o", "-q", join(out, zipName), first, "-d", join(out, "x")]);
  const probe = execFileSync("python3", ["-c", `
from PIL import Image
im = Image.open(r"${join(out, "x", first)}").convert("RGBA"); w, h = im.size
a = im.getchannel("A")
  if (errors.length) throw new Error("console errors: " + errors.join(" | "));
  console.log("E2E OK ->", out);
} catch (e) {
  failed = true; console.error("E2E FAILED:", e.message, "\nartifacts:", out);
} finally {
  await browser.close(); server.kill();
}
process.exit(failed ? 1 : 0);
