import type { RenderRequest, WorkerIn, WorkerOut } from "./worker";

export type Rendered = { width: number; height: number; data: ImageData; ms: number };
export type Encoded = { width: number; height: number; blob: Blob; ms: number };
export type Req = Omit<RenderRequest, "reqId" | "file" | "encode"> & { key?: string };

/** Thrown for queued requests replaced by a newer one with the same key. */
export class Superseded extends Error {
  constructor() {
    super("superseded");
  }
}

type Job = { msg: WorkerIn & { type: "render" }; key?: string; ok: (m: WorkerOut & { reqId: number }) => void; fail: (e: Error) => void };

const files = new Map<number, File>();
const MAX_WORKERS = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 2) / 2)));
const workers: { w: Worker; busy: Job | null }[] = [];
const queue: Job[] = [];
let nextReq = 1;
let nextImage = 1;

function spawn() {
  const w = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const slot = { w, busy: null as Job | null };
  w.onmessage = (e: MessageEvent<WorkerOut>) => {
    const job = slot.busy;
    slot.busy = null;
    if (job) {
      if ("error" in e.data) job.fail(new Error(e.data.error));
      else job.ok(e.data);
    }
    pump();
  };
  workers.push(slot);
}

function pump() {
  for (const slot of workers) {
    if (!slot.busy && queue.length) {
      slot.busy = queue.shift()!;
      slot.w.postMessage(slot.busy.msg);
    }
  }
  // grow the pool only when there is queued work no idle worker can take
  while (queue.length > 0 && workers.length < MAX_WORKERS && workers.every((s) => s.busy)) {
    spawn();
    pump();
  }
}

function submit(req: Req, encode?: RenderRequest["encode"]): Promise<WorkerOut & { reqId: number }> {
  if (!workers.length) spawn();
  const { key, ...rest } = req;
  const msg = {
    type: "render" as const, reqId: nextReq++, ...rest,
    file: req.imageId === null ? undefined : files.get(req.imageId), encode,
  };
  return new Promise((ok, fail) => {
    if (key) {
      for (let i = queue.length - 1; i >= 0; i--) {
        if (queue[i].key === key) queue.splice(i, 1)[0].fail(new Superseded());
      }
    }
    queue.push({ msg, key, ok, fail });
    pump();
  });
}

const MAX_PIXELS = 64_000_000;

/** Validates a user file and registers it. Pixels are decoded lazily inside whichever workers render it. */
export async function importImage(file: File): Promise<{ id: number; w: number; h: number; url: string }> {
  if (file.size > 80 * 1024 * 1024) throw new Error("File is larger than 80 MB.");
  if (!/^image\/(png|jpeg|webp|gif|bmp|avif)$/.test(file.type)) {
    throw new Error(`Unsupported file type${file.type ? ` (${file.type})` : ""}. Use PNG, JPEG or WebP.`);
  }
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("This image could not be decoded; the file may be corrupt.");
  }
  const { width: w, height: h } = bitmap;
  bitmap.close();
  if (w * h > MAX_PIXELS) throw new Error("Image is too large (limit 64 megapixels).");
  const id = nextImage++;
  files.set(id, file);
  return { id, w, h, url: URL.createObjectURL(file) };
}

export function dropImage(imageId: number) {
  files.delete(imageId);
  for (const s of workers) s.w.postMessage({ type: "dropImage", imageId } satisfies WorkerIn);
}

/** Renders to pixels (previews). A newer request with the same `key` supersedes a queued one. */
export async function render(req: Req): Promise<Rendered> {
  const m = (await submit(req)) as Extract<WorkerOut, { width: number }>;
  const data = new ImageData(new Uint8ClampedArray(m.buffer!), m.width, m.height);
  return { width: m.width, height: m.height, data, ms: m.ms };
}

/** Renders and encodes inside a worker (exports). */
export async function renderEncoded(req: Req, type: "image/png" | "image/jpeg" | "image/webp", quality = 0.92): Promise<Encoded> {
  const m = (await submit(req, { type, quality })) as Extract<WorkerOut, { width: number }>;
  return { width: m.width, height: m.height, blob: m.blob!, ms: m.ms };
}
