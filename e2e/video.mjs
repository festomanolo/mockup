// End-to-end check in real Chrome: the video studio loads, an image goes on the screen, and a short MP4 is
// rendered, downloaded and decoded again (size, duration, background and screen colours, and motion).
import puppeteer from "puppeteer-core";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const port = 5189;
const out = mkdtempSync(join(tmpdir(), "mockup-video-e2e-"));
const RES = process.env.RES ?? "1280", DUR = process.env.DUR ?? "2", AUDIO = !!process.env.AUDIO;
const device = process.env.DEVICE ?? "macbook-pro-14";
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };

const server = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { cwd: join(root, "web"), stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await puppeteer.launch({
  executablePath: chrome, headless: "new",
  args: ["--no-sandbox", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--allow-file-access-from-files"],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 1000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await (await page.createCDPSession()).send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: out });
  await page.goto(`http://localhost:${port}/video/${device}/`, { waitUntil: "load", timeout: 60000 });
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text()); });
  await page.waitForSelector("canvas.vcanvas").catch(async (e) => { console.log("ERRORS", errors, await page.evaluate(() => document.body.innerHTML.slice(0, 1500))); throw e; });

  const png = await page.evaluate(() => {
    const c = document.createElement("canvas"); c.width = 600; c.height = 400;
    const x = c.getContext("2d"); x.fillStyle = "#e02828"; x.fillRect(0, 0, 600, 400);
    return c.toDataURL("image/png").split(",")[1];
  });
  const shot = join(out, "red.png");
  writeFileSync(shot, Buffer.from(png, "base64"));
  await (await page.$('input[type=file][accept*="video"]')).uploadFile(shot);
  await new Promise((r) => setTimeout(r, 1000));

  await page.click('button[aria-label="Ocean background"]');
  await page.$eval('input[aria-label="Duration in seconds"]', (e) => { e.value = DUR; e.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.select('select[aria-label="Resolution"]', RES);
  await page.select('select[aria-label="Frame rate"]', "24");
  await page.select('select[aria-label="Format"]', "mp4");
  if (AUDIO) {
    const n = 48000 * 3, b = Buffer.alloc(44 + n * 2);
    b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(48000, 24); b.writeUInt32LE(96000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 48000) * 12000), 44 + i * 2);
    const wav = join(out, "tone.wav"); writeFileSync(wav, b);
    await (await page.$('input[type=file][accept="audio/*"]')).uploadFile(wav);
    await new Promise((r) => setTimeout(r, 800));
  }
  await page.click("button.primary");
  await page.waitForFunction(() => /Done|cannot|Error|failed/i.test(document.querySelector(".status")?.textContent ?? ""), { timeout: 540000 });
  const status = await page.$eval(".status", (e) => e.textContent);
  console.log("status:", status);
  if (!/^Done/.test(status)) fail(status);
  if (AUDIO && /Audio skipped/.test(status)) fail("audio was skipped");

  const mp4 = readdirSync(out).find((f) => f.endsWith(".mp4"));
  if (!mp4) fail("no mp4 downloaded");
  else {
    writeFileSync(join(out, "blank.html"), "<html><body></body></html>");
    const check = await browser.newPage(); // file:// media can only be read from a file:// page
    await check.goto("file://" + join(out, "blank.html"));
    const info = await check.evaluate(async (url) => {
      const v = document.createElement("video"); v.muted = true; v.src = url; document.body.append(v);
      await new Promise((ok, no) => { v.onloadeddata = ok; v.onerror = () => no(new Error("decode error")); });
      const grab = async (t) => {
        v.currentTime = t; await new Promise((ok) => (v.onseeked = ok));
        const c = document.createElement("canvas"); c.width = v.videoWidth; c.height = v.videoHeight;
        const x = c.getContext("2d"); x.drawImage(v, 0, 0);
        return { corner: [...x.getImageData(4, 4, 1, 1).data], data: x.getImageData(0, 0, c.width, c.height).data };
      };
      const a = await grab(0.05), b = await grab(1.9);
      let diff = 0; for (let i = 0; i < a.data.length; i += 4 * 97) diff += Math.abs(a.data[i] - b.data[i]);
      let red = 0; for (let i = 0; i < b.data.length; i += 4) if (b.data[i] > 180 && b.data[i + 1] < 90 && b.data[i + 2] < 90) red++;
      return { w: v.videoWidth, h: v.videoHeight, dur: v.duration, corner: a.corner, diff, red };
    }, "file://" + join(out, mp4));
    console.log(device, JSON.stringify(info));
    if (AUDIO) { const buf = readFileSync(join(out, mp4)); if (!buf.includes("mp4a")) fail("no AAC track in mp4"); else console.log("AAC track present"); }
    if (info.w !== Number(RES) || info.h !== Math.round(Number(RES) * 9 / 16)) fail(`size ${info.w}x${info.h}`);
    if (Math.abs(info.dur - Number(DUR)) > 0.15) fail(`duration ${info.dur}`);
    if (!(info.corner[2] > 200 && info.corner[0] < 120)) fail(`background is not the Ocean gradient: ${info.corner}`);
    if (info.red < 2000) fail(`screen image not visible (${info.red} red pixels)`);
    if (info.diff < 1000) fail("first and last frame are identical: camera did not move");
  }
  if (errors.length) fail("page errors: " + errors.join("; "));
  if (!process.exitCode) console.log("OK: video export verified");
} finally { await browser.close(); server.kill(); }
