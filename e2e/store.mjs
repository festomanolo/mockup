// End-to-end check of the store listing studio in real Chrome: panorama preview paints, a mock OpenAI-compatible
// server drives the AI writer (including the invalid-JSON retry), edits stick, and the exported ZIP has the right files and sizes.
import puppeteer from "puppeteer-core";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5191, aiPort = 5192;
const out = mkdtempSync(join(tmpdir(), "mockup-store-e2e-"));
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

let calls = 0;
const good = { slides: ["Plan your day", "Focus without noise", "Works fully offline", "Share in seconds", "Private by design", "Loved by thousands"].map((h) => ({ headline: h, sub: `${h} — made simple.` })),
  store: { title: "Lumen: Daily Planner", subtitle: "Plan calmly", short: "A calm daily planner that keeps you focused.", promo: "New: widgets!", keywords: "planner,todo,focus,habit", description: "Lumen helps you plan.", whatsNew: "First release." } };
const bad = { ...good, slides: good.slides.map((s, i) => (i === 0 ? { headline: "one two three four five six seven eight nine", sub: "x" } : s)) };
const mock = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204).end(); return; }
  req.resume().on("end", () => {
    calls++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ choices: [{ message: { content: "```json\n" + JSON.stringify(calls === 1 ? bad : good) + "\n```" } }] }));
  });
}).listen(aiPort);

const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: join(root, "web"), stdio: "ignore" });
await new Promise((r) => setTimeout(r, 3000));
const browser = await puppeteer.launch({
  executablePath: chrome, headless: "new", protocolTimeout: 600000,
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await (await page.createCDPSession()).send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: out });
  await page.goto(`http://localhost:${port}/store/`, { waitUntil: "load" });
  await page.waitForSelector("canvas.sslide", { timeout: 30000 });
  await page.waitForFunction(() => /slides ·/.test(document.querySelector(".sstrip-note")?.textContent ?? ""), { timeout: 120000 });
  const painted = await page.$$eval("canvas.sslide", (cs) => cs.map((c) => { const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data; let nz = 0; for (let i = 3; i < d.length; i += 4 * 211) if (d[i] > 0) nz++; return nz; }));
  console.log("slides painted (non-empty samples):", painted.join(","));
  if (painted.length !== 6 || painted.some((n) => n < 100)) fail("preview slides are not all painted");
  await (await page.$(".sstrip")).screenshot({ path: join(out, "strip.png") });

  // AI via the mock server (provider "custom"); first answer is invalid on purpose to exercise the retry
  await page.select('select[aria-label="AI provider"]', "custom");
  await page.$eval('input[aria-label="Base URL"]', (e, u) => { e.value = u; e.dispatchEvent(new Event("change", { bubbles: true })); }, `http://127.0.0.1:${aiPort}/v1`);
  await page.type('input[aria-label="Model"]', "mock-model");
  await page.type('textarea[aria-label="App idea"]', "A calm daily planner that keeps you focused with offline support.");
  await page.evaluate(() => [...document.querySelectorAll("label.chk")].find((l) => /I understand/.test(l.textContent)).querySelector("input").click());
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Write the words/.test(b.textContent)).click());
  await page.waitForFunction(() => /^Done|Stopped|rejected|Could not|did not/.test(document.querySelector(".status[role=status]")?.textContent ?? ""), { timeout: 30000 });
  const h1 = await page.$eval('input[aria-label="Slide 1 headline"]', (e) => e.value);
  console.log("calls to AI:", calls, "| slide 1 headline:", h1);
  if (calls !== 2) fail(`expected 2 AI calls (retry), got ${calls}`);
  if (h1 !== "Plan your day") fail("AI text not applied");
  const title = await page.$eval('textarea[aria-label="App name / title"]', (e) => e.value);
  if (!/Lumen/.test(title)) fail("store title not filled");

  // manual edit sticks and re-renders
  await page.click('input[aria-label="Slide 1 headline"]', { clickCount: 3 });
  await page.type('input[aria-label="Slide 1 headline"]', "Hand edited words");
  await new Promise((r) => setTimeout(r, 1500));

  // export (PNG, iPhone 6.9" + Play phone + feature graphic)
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => /Export listing ZIP/.test(b.textContent)).click());
  await page.waitForFunction(() => /^Done|failed|cannot|could not/i.test(document.querySelectorAll(".status")[document.querySelectorAll(".status").length - 1]?.textContent ?? ""), { timeout: 560000 });
  console.log("export:", await page.evaluate(() => [...document.querySelectorAll(".status")].pop().textContent));
  await new Promise((r) => setTimeout(r, 1500));
  const zipFile = readdirSync(out).find((f) => f.endsWith(".zip"));
  if (!zipFile) fail("no zip downloaded");
  else {
    const dir = join(out, "unz");
    execFileSync("unzip", ["-q", "-o", join(out, zipFile), "-d", dir]);
    const list = execFileSync("find", [dir, "-type", "f"]).toString().trim().split("\n").map((p) => p.replace(dir + "/", "")).sort();
    console.log(list.join("\n"));
    const png = (p) => { const b = readFileSync(join(dir, p)); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
    const sz = (p) => png(p).join("x");
    if (sz("app-store/iphone-6.9/01.png") !== "1320x2868") fail("iPhone 6.9 size " + sz("app-store/iphone-6.9/01.png"));
    if (sz("google-play/phone/06.png") !== "1080x1920") fail("Play phone size");
    if (!list.includes("google-play/feature-graphic-1024x500.jpg") || !list.includes("listing-copy.txt") || !list.includes("listing.json")) fail("missing files");
    const copy = readFileSync(join(dir, "listing-copy.txt"), "utf8");
    if (!/Hand edited words/.test(copy)) fail("manual edit not in export");
    console.log("zip dir:", dir);
  }
  if (errors.length) fail("page errors: " + errors.join("; "));
  if (!process.exitCode) console.log("OK: store studio verified");
} finally { await browser.close(); server.kill(); mock.close(); }
