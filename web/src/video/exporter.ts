// Frame-exact export: every frame is rendered, handed to WebCodecs and muxed. Nothing is recorded in real
// time, so the output never drops frames regardless of how slow the machine is.
import { ArrayBufferTarget as Mp4Target, Muxer as Mp4Muxer } from "mp4-muxer";
import { ArrayBufferTarget as WebmTarget, Muxer as WebmMuxer } from "webm-muxer";
import { zip } from "../zip";

export type AudioOpts = { file: Blob; volume: number; fadeOut: number };

export type ExportOpts = {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
  fps: number;
  duration: number;
  format: "mp4" | "webm" | "png";
  /** Keep the alpha channel (WebM/VP9, or PNG sequence). */
  alpha: boolean;
  /** Bits per pixel per frame; 0.1 is a good default for screen content. */
  quality: number;
  audio?: AudioOpts;
  /** Must draw frame `i` (time `i / fps`) onto `canvas`. */
  renderFrame(i: number, t: number): Promise<void>;
  onProgress(done: number, total: number): void;
  signal: AbortSignal;
};

export type ExportResult = { blob: Blob; codec: string; audioSkipped?: string };

const MP4_CODECS = ["avc1.640034", "avc1.640033", "avc1.64002a", "avc1.4d002a", "avc1.42002a"];
const WEBM_CODECS = ["vp09.00.51.08", "vp09.00.41.08", "vp09.00.31.08", "vp8"];

/** PNG sequences hold every frame in memory before zipping. */
export const MAX_PNG_FRAMES = 450;

/** True when this browser's VideoEncoder can write VP9/VP8 with an alpha channel. */
export async function alphaWebmSupported(): Promise<boolean> {
  if (typeof VideoEncoder === "undefined") return false;
  for (const codec of ["vp09.00.10.08", "vp8"]) {
    try {
      const r = await VideoEncoder.isConfigSupported({ codec, width: 640, height: 360, bitrate: 2e6, alpha: "keep" });
      if (r.supported) return true;
    } catch { /* ignore */ }
  }
  return false;
}

export function webCodecsSupported() {
  return typeof VideoEncoder !== "undefined" && typeof VideoFrame !== "undefined";
}

async function pickVideoConfig(o: ExportOpts): Promise<VideoEncoderConfig> {
  const bitrate = Math.round(Math.min(120e6, Math.max(3e6, o.width * o.height * o.fps * o.quality)));
  const list = o.format === "mp4" ? MP4_CODECS : WEBM_CODECS;
  for (const codec of list) {
    const cfg: VideoEncoderConfig = { codec, width: o.width, height: o.height, bitrate, framerate: o.fps };
    if (o.format === "mp4") Object.assign(cfg, { avc: { format: "avc" } });
    if (o.alpha && o.format === "webm") cfg.alpha = "keep";
    try {
      if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg;
    } catch { /* try the next codec */ }
  }
  throw new Error(
    `This browser cannot encode ${o.format === "mp4" ? "H.264" : o.alpha ? "VP9 with transparency" : "VP9"} at ${o.width}×${o.height}. Try a smaller resolution${o.format === "mp4" ? " or WebM" : ""}.`,
  );
}

/** Decodes, loops, fades and resamples the soundtrack to 48 kHz stereo for the clip's length. */
async function mixAudio(a: AudioOpts, duration: number): Promise<AudioBuffer> {
  const ctx = new AudioContext();
  let src: AudioBuffer;
  try { src = await ctx.decodeAudioData(await a.file.arrayBuffer()); } finally { void ctx.close(); }
  const rate = 48000;
  const off = new OfflineAudioContext(2, Math.ceil(duration * rate), rate);
  const node = off.createBufferSource();
  node.buffer = src; node.loop = true;
  const g = off.createGain();
  const fade = Math.min(a.fadeOut, duration);
  g.gain.setValueAtTime(a.volume, 0);
  if (fade > 0) { g.gain.setValueAtTime(a.volume, duration - fade); g.gain.linearRampToValueAtTime(0, duration); }
  node.connect(g).connect(off.destination);
  node.start();
  return off.startRendering();
}

async function encodeAudio(buf: AudioBuffer, format: "mp4" | "webm", add: (c: EncodedAudioChunk, m?: EncodedAudioChunkMetadata) => void) {
  const cfg: AudioEncoderConfig = { codec: format === "mp4" ? "mp4a.40.2" : "opus", sampleRate: buf.sampleRate, numberOfChannels: 2, bitrate: 160000 };
  if (!(await AudioEncoder.isConfigSupported(cfg)).supported) throw new Error(`This browser cannot encode ${format === "mp4" ? "AAC" : "Opus"} audio.`);
  let failure: Error | null = null;
  const enc = new AudioEncoder({ output: add, error: (e) => { failure = e; } });
  enc.configure(cfg);
  const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
  const step = 4800;
  for (let i = 0; i < buf.length; i += step) {
    const n = Math.min(step, buf.length - i);
    const planar = new Float32Array(n * 2);
    planar.set(L.subarray(i, i + n), 0);
    planar.set(R.subarray(i, i + n), n);
    const data = new AudioData({ format: "f32-planar", sampleRate: buf.sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: Math.round((i / buf.sampleRate) * 1e6), data: planar });
    enc.encode(data);
    data.close();
    while (enc.encodeQueueSize > 20) await new Promise((r) => setTimeout(r, 2));
  }
  await enc.flush();
  enc.close();
  if (failure) throw failure;
}

async function exportPngSequence(o: ExportOpts): Promise<ExportResult> {
  const total = Math.max(1, Math.round(o.duration * o.fps));
  if (total > MAX_PNG_FRAMES) throw new Error(`A PNG sequence is limited to ${MAX_PNG_FRAMES} frames (this clip has ${total}). Shorten the clip or lower the frame rate.`);
  const files: { name: string; data: Uint8Array }[] = [];
  const pad = String(total).length + 1;
  for (let i = 0; i < total; i++) {
    if (o.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
    await o.renderFrame(i, i / o.fps);
    const blob = await new Promise<Blob | null>((ok) => o.canvas.toBlob(ok, "image/png"));
    if (!blob) throw new Error("The browser could not encode a PNG frame (out of memory?).");
    files.push({ name: `frame_${String(i + 1).padStart(pad, "0")}.png`, data: new Uint8Array(await blob.arrayBuffer()) });
    o.onProgress(i + 1, total);
  }
  return { blob: zip(files), codec: "png" };
}

export async function exportVideo(o: ExportOpts): Promise<ExportResult> {
  if (o.format === "png") return exportPngSequence(o);
  if (!webCodecsSupported()) throw new Error("Video export needs WebCodecs (Chrome, Edge or Safari 16.4+).");
  const cfg = await pickVideoConfig(o);
  const total = Math.max(1, Math.round(o.duration * o.fps));

  // Audio first, so an unsupported soundtrack is reported before minutes of rendering.
  let audioBuf: AudioBuffer | null = null;
  let audioSkipped: string | undefined;
  if (o.audio) {
    try {
      if (typeof AudioEncoder === "undefined") throw new Error("This browser cannot encode audio.");
      const probe = { codec: o.format === "mp4" ? "mp4a.40.2" : "opus", sampleRate: 48000, numberOfChannels: 2, bitrate: 160000 };
      if (!(await AudioEncoder.isConfigSupported(probe)).supported) throw new Error(`This browser cannot encode ${o.format === "mp4" ? "AAC" : "Opus"} audio.`);
      audioBuf = await mixAudio(o.audio, o.duration);
    } catch (e) { audioSkipped = e instanceof Error ? e.message : String(e); }
  }
  const audioCfg = audioBuf ? { sampleRate: audioBuf.sampleRate, numberOfChannels: 2 } : null;

  let finish: () => Blob;
  let addVideo: (c: EncodedVideoChunk, m?: EncodedVideoChunkMetadata) => void;
  let addAudio: (c: EncodedAudioChunk, m?: EncodedAudioChunkMetadata) => void;
  if (o.format === "mp4") {
    const target = new Mp4Target();
    const m = new Mp4Muxer({
      target, fastStart: "in-memory",
      video: { codec: "avc", width: o.width, height: o.height, frameRate: o.fps },
      ...(audioCfg ? { audio: { codec: "aac" as const, ...audioCfg } } : {}),
    });
    addVideo = (c, meta) => m.addVideoChunk(c, meta);
    addAudio = (c, meta) => m.addAudioChunk(c, meta);
    finish = () => { m.finalize(); return new Blob([target.buffer], { type: "video/mp4" }); };
  } else {
    const target = new WebmTarget();
    const m = new WebmMuxer({
      target,
      video: { codec: cfg.codec.startsWith("vp8") ? "V_VP8" : "V_VP9", width: o.width, height: o.height, frameRate: o.fps, alpha: o.alpha },
      ...(audioCfg ? { audio: { codec: "A_OPUS" as const, ...audioCfg } } : {}),
    });
    addVideo = (c, meta) => m.addVideoChunk(c, meta);
    addAudio = (c, meta) => m.addAudioChunk(c, meta);
    finish = () => { m.finalize(); return new Blob([target.buffer], { type: "video/webm" }); };
  }

  let failure: Error | null = null;
  const enc = new VideoEncoder({ output: (c, meta) => addVideo(c, meta), error: (e) => { failure = e; } });
  enc.configure(cfg);
  const frameUs = 1e6 / o.fps;
  try {
    for (let i = 0; i < total; i++) {
      if (o.signal.aborted) throw new DOMException("Export cancelled", "AbortError");
      if (failure) throw failure;
      await o.renderFrame(i, i / o.fps);
      const frame = new VideoFrame(o.canvas, { timestamp: Math.round(i * frameUs), duration: Math.round(frameUs), alpha: o.alpha ? "keep" : "discard" });
      while (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 2));
      enc.encode(frame, { keyFrame: i % (o.fps * 2) === 0 });
      frame.close();
      o.onProgress(i + 1, total);
      if (i % 4 === 3) await new Promise((r) => setTimeout(r)); // keep the UI responsive
    }
    await enc.flush();
    if (failure) throw failure;
    if (audioBuf) await encodeAudio(audioBuf, o.format, addAudio);
  } finally {
    if (enc.state !== "closed") enc.close();
  }
  return { blob: finish(), codec: cfg.codec, audioSkipped };
}
