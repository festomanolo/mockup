// End-to-end check of the guided flow in real Chrome: raw screenshots are classified (best / similar / empty / finished
// mockup), the choices carry over to the video and store studios, the gradient and shape editors work, and shapes are
// continuous across slide edges.
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5194;
const out = mkdtempSync(join(tmpdir(), "mockup-guided-e2e-"));
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: join(root, "web"), stdio: "ignore" });
await sleep(3000);
const browser = await puppeteer.launch({
  executablePath: chrome, headless: "new", protocolTimeout: 600000,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/studio/`, { waitUntil: "load" });

  // five synthetic screenshots
  const imgs = await page.evaluate(() => {
    const mk = (draw, w = 600, h = 1300) => { const c = document.createElement("canvas"); c.width = w; c.height = h; const x = c.getContext("2d"); draw(x, w, h); return c.toDataURL("image/png").split(",")[1]; };
    const rows = (x, w, h, off) => { x.fillStyle = "#eef1f6"; x.fillRect(0, 0, w, h); for (let i = 0; i < 9; i++) { x.fillStyle = `hsl(${(i * 40 + off) % 360} 70% 55%)`; x.fillRect(30, 40 + i * 130, 120, 100); x.fillStyle = "#222"; x.fillRect(180, 60 + i * 130, 300 - i * 12, 18); x.fillStyle = "#aab"; x.fillRect(180, 96 + i * 130, 240, 12); } };
    return {
      a: mk((x, w, h) => rows(x, w, h, 0)),
      b: mk((x, w, h) => { x.fillStyle = "#101828"; x.fillRect(0, 0, w, h); for (let i = 0; i < 40; i++) { x.fillStyle = `hsl(${i * 9} 80% 60%)`; x.beginPath(); x.arc(40 + (i * 97) % 520, 60 + (i * 211) % 1180, 14 + (i % 5) * 9, 0, 7); x.fill(); } }),
      c: mk((x, w, h) => { rows(x, w, h, 0); x.fillStyle = "#eef1f6"; x.fillRect(560, 1280, 30, 14); }),
      d: mk((x, w, h) => { x.fillStyle = "#ffffff"; x.fillRect(0, 0, w, h); }),
      e: mk((x, w, h) => { x.clearRect(0, 0, w, h); x.fillStyle = "#222"; x.beginPath(); x.roundRect(60, 80, w - 120, h - 160, 70); x.fill(); x.fillStyle = "#4f7cff"; x.beginPath(); x.roundRect(80, 100, w - 160, h - 200, 55); x.fill(); }),
    };
  });
  const files = [];
  for (const [k, b64] of Object.entries(imgs)) { const p = join(out, `shot-${k}.png`); writeFileSync(p, Buffer.from(b64, "base64")); files.push(p); }
  await (await page.$('input[type=file][aria-label="Add screenshots"]')).uploadFile(...files);
  await page.waitForFunction(() => document.querySelectorAll(".witem").length === 5, { timeout: 60000 });
  await sleep(1500);
  const info = await page.$$eval(".witem", (els) => els.map((e) => ({ name: e.querySelector(".wname").textContent, badges: [...e.querySelectorAll(".badge")].map((b) => b.textContent), on: [...e.querySelectorAll(".wtoggles .chip")].map((b) => b.getAttribute("aria-pressed") === "true") })));
  console.log(JSON.stringify(info));
  const by = (n) => info.find((x) => x.name.includes(n));
  if (!by("shot-d").badges.includes("Looks empty")) fail("blank shot not flagged");
  if (!by("shot-e").badges.includes("Finished mockup")) fail("transparent mockup not detected");
  if (!(by("shot-a").badges.includes("Similar to another") || by("shot-c").badges.includes("Similar to another"))) fail("duplicate not flagged");
  if (!info.some((x) => x.badges.includes("★ Suggested"))) fail("nothing suggested");
  if (by("shot-d").on[1]) fail("empty shot should not be auto-selected for the store");
  if (by("shot-e").on[0]) fail("finished mockup must not go to video");
  if (!by("shot-b").on[0]) fail("distinct shot should be suggested for video");

  // continue to the store listing through the in-app link (the library survives navigation)
  await page.click("a.bigbtn[href='/store/']");
  await page.waitForSelector("canvas.sslide", { timeout: 30000 });
  await page.waitForFunction(() => /slides ·/.test(document.querySelector(".sstrip-note")?.textContent ?? ""), { timeout: 120000 });
  const nShots = await page.$$eval(".shot", (e) => e.length);
  const mockChip = await page.$$eval(".shot .mode", (e) => e.map((b) => b.textContent));
  console.log("store shots:", nShots, mockChip.join(","));
  if (nShots < 2) fail("library screens did not reach the store");
  if (!mockChip.includes("Mockup")) fail("finished mockup flag lost");

  // gradient editor: add a stop, shapes gallery: pick waves, then check continuity across slide edges
  const stopsBefore = await page.$$eval(".stop", (e) => e.length);
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Add colour/.test(b.textContent)).click());
  const stopsAfter = await page.$$eval(".stop", (e) => e.length);
  if (stopsAfter !== stopsBefore + 1) fail("gradient stop not added");
  const galleryN = await page.$$eval(".shapechip", (e) => e.length);
  if (galleryN < 18) fail("shape gallery too small: " + galleryN);
  await page.evaluate(() => document.querySelector('button.shapechip[title="Waves"]').click());
  await page.evaluate(() => [...document.querySelectorAll("label.chk input")].find((i) => i.parentElement.textContent.includes("Seamless"))).catch(() => {});
  const edgeDiff = async () => {
    await sleep(500);
    await page.waitForFunction(() => /slides ·/.test(document.querySelector(".sstrip-note")?.textContent ?? ""), { timeout: 120000 });
    await sleep(2500);
    return page.$$eval("canvas.sslide", (cs) => {
      let tot = 0, n = 0;
      for (let i = 0; i + 1 < cs.length; i++) {
        const a = cs[i].getContext("2d").getImageData(cs[i].width - 1, 0, 1, cs[i].height).data, b = cs[i + 1].getContext("2d").getImageData(0, 0, 1, cs[i + 1].height).data;
        for (let y = 0; y < cs[i].height; y += 3) { tot += Math.abs(a[y * 4] - b[y * 4]) + Math.abs(a[y * 4 + 1] - b[y * 4 + 1]) + Math.abs(a[y * 4 + 2] - b[y * 4 + 2]); n += 3; }
      }
      return tot / n;
    });
  };
  const seamlessDiff = await edgeDiff();
  await page.evaluate(() => [...document.querySelectorAll("label.chk")].find((l) => l.textContent.includes("Seamless")).querySelector("input").click());
  const separateDiff = await edgeDiff();
  console.log("edge difference seamless vs separate:", seamlessDiff.toFixed(2), separateDiff.toFixed(2));
  if (seamlessDiff > 8) fail(`seams visible in seamless mode (${seamlessDiff})`);
  if (!(separateDiff > seamlessDiff * 1.5)) fail("separate mode should show a seam");
  await page.evaluate(() => [...document.querySelectorAll("label.chk")].find((l) => l.textContent.includes("Seamless")).querySelector("input").click());
  await sleep(800);
  await page.screenshot({ path: join(out, "store.png") });

  // video studio receives the screens
  await page.evaluate(() => history.pushState(null, "", "/video/iphone-15-pro/") || dispatchEvent(new PopStateEvent("popstate")));
  await page.waitForSelector("canvas.vcanvas", { timeout: 60000 });
  await page.waitForFunction(() => /from your library|\.png/.test([...document.querySelectorAll("p.fine")].map((p) => p.textContent).join(" ")), { timeout: 30000 });
  const vinfo = await page.evaluate(() => [...document.querySelectorAll("p.fine")].map((p) => p.textContent).filter((t) => /library|png/.test(t)).join(" | "));
  console.log("video:", vinfo);
  if (!/screens from your library|shot-/.test(vinfo)) fail("video studio did not take the library screens");

  if (errors.length) fail("page errors: " + errors.join("; "));
  console.log("artifacts:", out);
  if (!process.exitCode) console.log("OK: guided flow verified");
} finally { await browser.close(); server.kill(); }
