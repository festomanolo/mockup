// The WebGL stage: renderer, lights, background, ground shadow, camera rig and the device.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { buildDevice, type DeviceModel, type DeviceSpec, type Fit } from "./device3d";
import { evaluate, type Key } from "./animation";

export type Bg =
  | { kind: "transparent" }
  | { kind: "solid"; color: string }
  | { kind: "linear"; from: string; to: string; angle: number }
  | { kind: "image"; img: HTMLImageElement };

export type LightPreset = "studio" | "soft" | "dramatic" | "bright";

export type StageSettings = {
  bg: Bg;
  light: LightPreset;
  envIntensity: number;
  exposure: number;
  shadow: number; // 0 = off
  glare: number; // 0..1
  fov: number;
  float: number; // 0..1 idle motion intensity
  landscape: boolean;
  fit: Fit;
};

export const DEFAULT_SETTINGS: StageSettings = {
  bg: { kind: "linear", from: "#4facfe", to: "#00f2fe", angle: 135 }, light: "studio", envIntensity: 1, exposure: 1, shadow: 0.5, glare: 0.5, fov: 28, float: 0.25, landscape: false, fit: "cover",
};

export type Media =
  | { kind: "image"; el: HTMLImageElement | ImageBitmap; w: number; h: number }
  | { kind: "video"; el: HTMLVideoElement; w: number; h: number };

const LIGHTS: Record<LightPreset, { key: number; fill: number; rim: number; ambient: number; keyPos: [number, number, number] }> = {
  studio: { key: 2.2, fill: 0.5, rim: 1.2, ambient: 0.15, keyPos: [400, 600, 700] },
  soft: { key: 1.0, fill: 1.0, rim: 0.4, ambient: 0.5, keyPos: [0, 500, 800] },
  dramatic: { key: 3.4, fill: 0.08, rim: 2.0, ambient: 0.02, keyPos: [-700, 300, 400] },
  bright: { key: 2.6, fill: 1.4, rim: 0.8, ambient: 0.6, keyPos: [300, 700, 800] },
};

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(28, 16 / 9, 5, 20000);
  settings: StageSettings = structuredClone(DEFAULT_SETTINGS);
  private model: DeviceModel | null = null;
  private spec: DeviceSpec | null = null;
  private pivot = new THREE.Group();
  private shadowMesh: THREE.Mesh;
  private shadowMat: THREE.MeshBasicMaterial;
  private key = new THREE.DirectionalLight(0xffffff, 1);
  private fill = new THREE.DirectionalLight(0xffffff, 0.5);
  private rim = new THREE.DirectionalLight(0xffffff, 1);
  private amb = new THREE.AmbientLight(0xffffff, 0.2);
  private texture: THREE.Texture | null = null;
  private placeholder: THREE.CanvasTexture | null = null;
  private media: Media | null = null;
  private bgTex: THREE.CanvasTexture | null = null;
  private bgKey = "";
  private width = 2;
  private height = 2;
  private pr = 1;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setClearColor(0x000000, 0);
    const pm = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    pm.dispose();
    this.scene.add(this.key, this.fill, this.rim, this.amb, this.pivot);
    this.shadowMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, toneMapped: false });
    this.shadowMesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.shadowMat);
    this.shadowMesh.rotation.x = -Math.PI / 2;
    this.shadowMesh.renderOrder = -1;
    this.scene.add(this.shadowMesh);
    this.applySettings();
  }

  /** Preview size in CSS px; the drawing buffer follows the device pixel ratio. */
  setViewport(w: number, h: number, pixelRatio: number) {
    this.width = Math.max(2, Math.round(w));
    this.height = Math.max(2, Math.round(h));
    this.pr = pixelRatio;
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(this.width, this.height, false);
    this.updateAspect();
  }

  /** Switches to an exact pixel size for export; call the returned function to restore the preview size. */
  enterExport(w: number, h: number) {
    const prev: [number, number, number] = [this.width, this.height, this.pr];
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(w, h, false);
    this.width = w; this.height = h; this.pr = 1;
    this.updateAspect();
    return () => this.setViewport(prev[0], prev[1], prev[2]);
  }

  get aspect() { return this.width / this.height; }
  private updateAspect() {
    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
    this.bgKey = ""; // regenerate background for the new aspect
  }

  setDevice(spec: DeviceSpec, finish: number) {
    if (this.model) { this.pivot.remove(this.model.group); this.model.dispose(); }
    this.spec = spec;
    this.model = buildDevice(spec);
    this.model.setFinish(spec.finishes[finish].color);
    this.pivot.add(this.model.group);
    this.applySettings();
    this.setMedia(this.media);
  }

  setFinish(i: number) { if (this.model && this.spec) this.model.setFinish(this.spec.finishes[i].color); }

  setMedia(m: Media | null) {
    this.media = m;
    this.texture?.dispose();
    this.texture = null;
    if (!this.model) return;
    let tex: THREE.Texture;
    let aspect: number;
    if (m) {
      tex = m.kind === "video" ? new THREE.VideoTexture(m.el) : new THREE.Texture(m.el as HTMLImageElement);
      aspect = m.w / m.h;
    } else {
      this.placeholder ??= placeholderTexture(this.spec!);
      tex = this.placeholder; aspect = this.spec!.screen.w / this.spec!.screen.h;
    }
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    // video frames are re-uploaded every draw: no mipmaps (the browser's video upload path does not support them)
    tex.generateMipmaps = m?.kind !== "video";
    tex.minFilter = m?.kind === "video" ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    if (m) this.texture = tex;
    this.model.setMap(tex, aspect, this.settings.fit);
  }

  applySettings() {
    const s = this.settings;
    const L = LIGHTS[s.light];
    this.key.intensity = L.key; this.key.position.set(...L.keyPos);
    this.fill.intensity = L.fill; this.fill.position.set(-L.keyPos[0] - 300, 100, 500);
    this.rim.intensity = L.rim; this.rim.position.set(-200, 400, -700);
    this.amb.intensity = L.ambient;
    this.scene.environmentIntensity = s.envIntensity;
    this.renderer.toneMappingExposure = s.exposure;
    this.camera.fov = s.fov;
    this.camera.updateProjectionMatrix();
    if (this.model) {
      this.model.setGlare(s.glare);
      this.pivot.rotation.z = s.landscape && this.spec && (this.spec.kind === "phone" || this.spec.kind === "tablet") ? Math.PI / 2 : 0;
      this.pivot.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(this.pivot);
      this.shadowMesh.position.set(0, box.min.y - 0.5, 0);
      const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z, 1) * 1.7;
      this.shadowMesh.scale.set(span, span * 0.8, 1);
      this.shadowMat.opacity = Math.min(1, s.shadow);
      this.shadowMesh.visible = s.shadow > 0;
      this.model.setMap(this.texture ?? this.placeholder, this.media ? this.media.w / this.media.h : this.spec!.screen.w / this.spec!.screen.h, s.fit);
    }
    this.bgKey = "";
  }

  /**
   * Camera distance that keeps every corner of the model's bounding box inside ~82% of the frame for
   * the whole range of turn angles the presets use, so nothing is clipped and the device is not tiny.
   */
  private fitDistance(): number {
    const m = this.model!;
    const land = this.pivot.rotation.z !== 0;
    const hx = m.size.x / 2, hy = m.size.y / 2, hz = m.size.z / 2;
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    const fillY = 0.82 * t, fillX = 0.82 * t * this.camera.aspect;
    const { yaw: ry, pitch: rp } = this.restPose;
    const pitch = (rp * Math.PI) / 180;
    let need = 0;
    for (let yd = -45; yd <= 45; yd += 15) {
      const yaw = ((ry + yd) * Math.PI) / 180;
      const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
      const right = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
      const up = dir.clone().cross(right);
      for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
        const p = new THREE.Vector3(sx * hx, sy * hy, sz * hz);
        if (land) p.applyAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2);
        need = Math.max(need, p.dot(dir) + Math.abs(p.dot(up)) / fillY, p.dot(dir) + Math.abs(p.dot(right)) / fillX);
      }
    }
    return need;
  }

  private updateBackground() {
    const bg = this.settings.bg;
    if (bg.kind === "transparent") { this.scene.background = null; return; }
    const key = `${JSON.stringify(bg.kind === "image" ? bg.img.src.slice(-40) : bg)}|${this.width}x${this.height}`;
    if (key === this.bgKey && this.bgTex) { this.scene.background = this.bgTex; return; }
    this.bgKey = key;
    const k = Math.min(1, 2048 / Math.max(this.width, this.height));
    const w = Math.max(2, Math.round(this.width * k)), h = Math.max(2, Math.round(this.height * k));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d")!;
    if (bg.kind === "solid") { x.fillStyle = bg.color; x.fillRect(0, 0, w, h); }
    else if (bg.kind === "linear") {
      const a = (bg.angle * Math.PI) / 180, dx = Math.sin(a), dy = -Math.cos(a);
      const len = Math.abs(w * dx) + Math.abs(h * dy);
      const g = x.createLinearGradient(w / 2 - (dx * len) / 2, h / 2 - (dy * len) / 2, w / 2 + (dx * len) / 2, h / 2 + (dy * len) / 2);
      g.addColorStop(0, bg.from); g.addColorStop(1, bg.to);
      x.fillStyle = g; x.fillRect(0, 0, w, h);
    } else {
      const { naturalWidth: iw, naturalHeight: ih } = bg.img;
      const s = Math.max(w / iw, h / ih);
      x.drawImage(bg.img, (w - iw * s) / 2, (h - ih * s) / 2, iw * s, ih * s);
    }
    this.bgTex?.dispose();
    this.bgTex = new THREE.CanvasTexture(c);
    this.bgTex.colorSpace = THREE.SRGBColorSpace;
    this.scene.background = this.bgTex;
  }

  /** Baseline resting pose: laptops/iMacs sit at a slight 3/4 angle, phones face the camera. */
  get restPose() {
    const k = this.spec?.kind;
    return k === "laptop" || k === "imac" ? { yaw: -18, pitch: 8 } : { yaw: -14, pitch: 6 };
  }
  get videoMedia(): HTMLVideoElement | null { return this.media?.kind === "video" ? this.media.el : null; }

  /** Draws one frame. `u` is the normalised animation time, `cycles` the idle-motion loops per clip. */
  draw(keys: Key[], u: number, cycles = 1) {
    if (!this.model) return;
    const pose = evaluate(keys, u);
    const R = this.fitDistance() / Math.max(0.05, pose.zoom);
    // a tight depth range keeps the thin screen layers from z-fighting at laptop/iMac distances
    this.camera.near = Math.max(1, R * 0.2);
    this.camera.far = R * 5;
    this.camera.updateProjectionMatrix();
    const yaw = (pose.yaw * Math.PI) / 180, pitch = (pose.pitch * Math.PI) / 180;
    const ph = 2 * Math.PI * cycles * u;
    const f = this.settings.float;
    // idle float: tiny bob and sway that loops seamlessly over the clip
    this.pivot.position.y = Math.sin(ph) * 6 * f;
    this.pivot.rotation.y = Math.sin(ph + 1.3) * 0.045 * f;
    this.pivot.rotation.x = Math.sin(ph * 2 + 0.4) * 0.02 * f;
    const dir = new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    this.camera.position.copy(dir).multiplyScalar(R);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(0, 0, 0);
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 1);
    const land = this.pivot.rotation.z !== 0;
    const fw = land ? this.model.front.h : this.model.front.w, fh = land ? this.model.front.w : this.model.front.h;
    const off = right.multiplyScalar(pose.panX * fw).add(up.multiplyScalar(pose.panY * fh));
    this.camera.position.add(off);
    this.camera.lookAt(off);
    this.camera.rotateZ((pose.roll * Math.PI) / 180);
    if (this.media?.kind === "video" && this.texture && this.media.el.readyState >= 2) this.texture.needsUpdate = true;
    this.updateBackground();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.model?.dispose();
    this.texture?.dispose();
    this.bgTex?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

function shadowTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 256;
  const x = c.getContext("2d")!;
  const g = x.createRadialGradient(128, 128, 8, 128, 128, 126);
  g.addColorStop(0, "rgba(0,0,0,0.75)");
  g.addColorStop(0.45, "rgba(0,0,0,0.35)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  x.fillStyle = g; x.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

/** Shown on the screen until the user adds media. */
function placeholderTexture(spec: DeviceSpec) {
  const w = 720, h = Math.round((720 * spec.screen.h) / spec.screen.w);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const x = c.getContext("2d")!;
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#2b6cff"); g.addColorStop(1, "#8b5cf6");
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  x.fillStyle = "rgba(255,255,255,.14)";
  x.beginPath(); x.roundRect(w * 0.08, h * 0.12, w * 0.84, h * 0.1, 18); x.fill();
  for (let i = 0; i < 3; i++) { x.beginPath(); x.roundRect(w * 0.08, h * (0.3 + i * 0.17), w * 0.84, h * 0.14, 24); x.fill(); }
  x.fillStyle = "#fff"; x.textAlign = "center";
  x.font = `600 ${Math.round(Math.min(w, h) * 0.06)}px system-ui, sans-serif`;
  x.fillText("Add an image or video", w / 2, h * 0.9);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
