/// <reference lib="webworker" />
import init, { output_size, render } from "./wasm/mockup_core.js";

export type RenderRequest = {
  reqId: number;
  deviceId: string;
  finish: number;
  orientation: string;
  fit: string;
  /** Longest output side in px; with `native` the render never exceeds the screen's native resolution. */
  maxSide: number;
  native: boolean;
  imageId: number | null;
  /** Source file; decoded here on a cache miss so only workers that render an image hold its pixels. */
  file?: File;
  /** When set the result is encoded in the worker and returned as a Blob. */
  encode?: { type: "image/png" | "image/jpeg" | "image/webp"; quality: number };
};
export type WorkerIn = ({ type: "render" } & RenderRequest) | { type: "dropImage"; imageId: number };
export type WorkerOut =
  | { reqId: number; width: number; height: number; ms: number; buffer?: ArrayBuffer; blob?: Blob }
  | { reqId: number; error: string };

const ready = init();
const MAX_CACHED = 3;
const images = new Map<number, { rgba: Uint8ClampedArray; w: number; h: number }>();

async function getImage(id: number, file?: File) {
  const hit = images.get(id);
  if (hit) {
    images.delete(id);
    images.set(id, hit); // most recently used
    return hit;
  }
  if (!file) throw new Error("Screenshot is no longer available.");
  const bitmap = await createImageBitmap(file);
  const c = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const img = { rgba: d.data, w: c.width, h: c.height };
  images.set(id, img);
  while (images.size > MAX_CACHED) images.delete(images.keys().next().value!);
  return img;
}

async function encode(buf: Uint8ClampedArray, w: number, h: number, type: string, quality: number): Promise<Blob> {
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d")!;
  const data = new ImageData(buf as Uint8ClampedArray<ArrayBuffer>, w, h);
  if (type === "image/jpeg") {
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, w, h);
    const tmp = new OffscreenCanvas(w, h);
    tmp.getContext("2d")!.putImageData(data, 0, 0);
    ctx.drawImage(tmp, 0, 0);
  } else {
    ctx.putImageData(data, 0, 0);
  }
  return c.convertToBlob({ type, quality });
}

const post = (m: WorkerOut, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<WorkerIn>) => {
  const m = e.data;
  await ready;
  if (m.type === "dropImage") {
    images.delete(m.imageId);
    return;
  }
  try {
    const img = m.imageId === null ? null : await getImage(m.imageId, m.file);
    const t0 = performance.now();
    const [w1, h1] = output_size(m.deviceId, m.orientation, 1);
    let scale = m.maxSide / Math.max(w1, h1);
    if (m.native) scale = Math.min(1, scale);
    const r = render(
      m.deviceId, m.finish, m.orientation, m.fit, scale,
      img ? new Uint8Array(img.rgba.buffer) : new Uint8Array(0), img?.w ?? 0, img?.h ?? 0,
    );
    const data = r.take_data();
    const [width, height] = [r.width, r.height];
    r.free();
    const ms = performance.now() - t0;
    if (m.encode) {
      const blob = await encode(new Uint8ClampedArray(data.buffer), width, height, m.encode.type, m.encode.quality);
      post({ reqId: m.reqId, width, height, ms, blob });
    } else {
      post({ reqId: m.reqId, width, height, ms, buffer: data.buffer as ArrayBuffer }, [data.buffer as ArrayBuffer]);
    }
  } catch (err) {
    post({ reqId: m.reqId, error: String(err instanceof Error ? err.message : err) });
  }
};
