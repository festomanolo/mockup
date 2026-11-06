// Builds a Three.js model of a device from the same manifest (devices.json) the still renderer uses.
// Units are millimetres, +y up, +z toward the viewer; the front face of every slab sits at local z = 0.
import * as THREE from "three";

export type Cam =
  | { kind: "none" }
  | { kind: "punch"; y: number; r: number }
  | { kind: "island"; y: number; w: number; h: number }
  | { kind: "notch"; w: number; h: number }
  | { kind: "dot"; y: number; r: number };

export type DeviceSpec = {
  id: string; name: string; kind: "phone" | "tablet" | "laptop" | "imac";
  body: { w: number; h: number; d: number; corner_r: number; edge_r: number; frame: number };
  screen: { w: number; h: number; diag_in: number; radius_mm: number; dy?: number };
  camera: Cam;
  finishes: { name: string; color: string }[];
  laptop?: { lid_t: number; open_deg: number };
  stand?: { total_h: number; foot_w: number; foot_d: number; foot_t: number };
  bezel_color?: string;
};

export type Fit = "cover" | "contain" | "stretch";

export type DeviceModel = {
  group: THREE.Group;
  /** Bounding box of the model (centred on the origin). */
  size: THREE.Vector3;
  /** Front-facing extent used to frame the camera: width/height of the visible screen side, mm. */
  front: { w: number; h: number };
  setFinish(hex: string): void;
  setMap(tex: THREE.Texture | null, aspect: number, fit: Fit): void;
  setGlare(k: number): void;
  /** Y of the lowest point (for a ground shadow). */
  floorY: number;
  dispose(): void;
};

function rrect(shape: THREE.Shape, hw: number, hh: number, r: number) {
  r = Math.max(0.01, Math.min(r, hw, hh));
  shape.moveTo(-hw + r, -hh);
  shape.lineTo(hw - r, -hh);
  shape.absarc(hw - r, -hh + r, r, -Math.PI / 2, 0, false);
  shape.lineTo(hw, hh - r);
  shape.absarc(hw - r, hh - r, r, 0, Math.PI / 2, false);
  shape.lineTo(-hw + r, hh);
  shape.absarc(-hw + r, hh - r, r, Math.PI / 2, Math.PI, false);
  shape.lineTo(-hw, -hh + r);
  shape.absarc(-hw + r, -hh + r, r, Math.PI, Math.PI * 1.5, false);
  return shape;
}

/** Rounded slab: front face at z = 0, thickness toward -z, filleted edge of radius `e`. */
function slab(hw: number, hh: number, r: number, depth: number, e: number) {
  e = Math.max(0.05, Math.min(e, depth / 2 - 0.01, r - 0.1));
  const shape = rrect(new THREE.Shape(), hw - e, hh - e, r - e);
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - 2 * e, bevelEnabled: true, bevelThickness: e, bevelSize: e, bevelSegments: 5, curveSegments: 14,
  });
  g.translate(0, 0, -(depth - e));
  return g;
}

/** Flat rounded-rectangle with 0..1 UVs (ShapeGeometry would use raw positions). */
function rrectPlane(w: number, h: number, r: number) {
  const g = new THREE.ShapeGeometry(rrect(new THREE.Shape(), w / 2, h / 2, r), 14);
  const p = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, p.getX(i) / w + 0.5, p.getY(i) / h + 0.5);
  return g;
}

function keyboardTexture(w: number, h: number, base: string) {
  const s = 6; // px per mm
  const c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  const x = c.getContext("2d")!;
  x.fillStyle = base; x.fillRect(0, 0, c.width, c.height);
  // keyboard well
  const kw = w * 0.84, kh = h * 0.36, kx = (w - kw) / 2, ky = h * 0.07;
  x.fillStyle = "rgba(10,10,12,0.92)";
  x.beginPath(); x.roundRect(kx * s, ky * s, kw * s, kh * s, 6); x.fill();
  const rows = 6, gap = 0.7;
  for (let r = 0; r < rows; r++) {
    const n = r === 0 ? 14 : r === 5 ? 9 : 13;
    const kwid = (kw - gap * (n + 1)) / n, khei = (kh - gap * (rows + 1)) / rows;
    for (let i = 0; i < n; i++) {
      x.fillStyle = "#2a2b2e";
      x.beginPath();
      x.roundRect((kx + gap + i * (kwid + gap)) * s, (ky + gap + r * (khei + gap)) * s, kwid * s, khei * s, 4);
      x.fill();
    }
  }
  // trackpad
  const tw = w * 0.38, th = h * 0.3;
  x.strokeStyle = "rgba(0,0,0,0.22)"; x.lineWidth = 2;
  x.beginPath(); x.roundRect(((w - tw) / 2) * s, (h * 0.52) * s, tw * s, th * s, 10); x.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}

export function buildDevice(d: DeviceSpec): DeviceModel {
  const b = d.body;
  const diag = d.screen.diag_in * 25.4, hyp = Math.hypot(d.screen.w, d.screen.h);
  const aw = (diag * d.screen.w) / hyp, ah = (diag * d.screen.h) / hyp;
  const sy = -(d.screen.dy ?? 0);
  const finish = new THREE.Color(d.finishes[0].color);

  const metal = new THREE.MeshPhysicalMaterial({ color: finish, metalness: 1, roughness: 0.28, envMapIntensity: 1, clearcoat: 0.15 });
  const deckMat = new THREE.MeshPhysicalMaterial({ color: finish, metalness: 1, roughness: 0.34 });
  const glassColor = d.kind === "imac" && d.bezel_color ? d.bezel_color : "#050506";
  const glassMat = new THREE.MeshPhysicalMaterial({ color: glassColor, metalness: 0, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 0.9 });
  const blackMat = new THREE.MeshBasicMaterial({ color: 0x000000 });
  const screenMat = new THREE.MeshBasicMaterial({ color: 0x111114, toneMapped: false });
  const glareMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, transparent: true, opacity: 0.05, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02,
    envMapIntensity: 1.6, depthWrite: false,
  });

  const disposables: { dispose(): void }[] = [metal, deckMat, glassMat, blackMat, screenMat, glareMat];
  const geom = <T extends THREE.BufferGeometry>(g: T) => (disposables.push(g), g);
  const root = new THREE.Group();

  /** A display module (glass + screen + camera cutout) on a slab whose front is local z = 0. */
  const display = (parent: THREE.Object3D, depth: number) => {
    const body = new THREE.Mesh(geom(slab(b.w / 2, b.h / 2, b.corner_r, depth, b.edge_r)), metal);
    parent.add(body);
    const inset = b.edge_r + b.frame;
    const gw = b.w - 2 * inset, gh = b.h - 2 * inset;
    const glass = new THREE.Mesh(geom(rrectPlane(gw, gh, Math.max(0.5, b.corner_r - inset))), glassMat);
    glass.position.z = 0.05;
    parent.add(glass);
    const backing = new THREE.Mesh(geom(rrectPlane(aw, ah, d.screen.radius_mm)), blackMat);
    backing.position.set(0, sy, 0.1);
    parent.add(backing);
    const screen = new THREE.Mesh(geom(rrectPlane(aw, ah, d.screen.radius_mm)), screenMat);
    screen.position.set(0, sy, 0.16);
    parent.add(screen);
    const glare = new THREE.Mesh(geom(rrectPlane(aw, ah, d.screen.radius_mm)), glareMat);
    glare.position.set(0, sy, 0.24);
    parent.add(glare);
    // camera cutout
    const top = sy + ah / 2;
    const cam = d.camera;
    const dark = (g: THREE.BufferGeometry, x: number, y: number) => {
      const m = new THREE.Mesh(geom(g), blackMat);
      m.position.set(x, y, 0.32);
      parent.add(m);
    };
    if (cam.kind === "punch") dark(new THREE.CircleGeometry(cam.r, 28), 0, top - cam.y);
    else if (cam.kind === "island") dark(rrectPlane(cam.w, cam.h, cam.h / 2), 0, top - cam.y - cam.h / 2);
    else if (cam.kind === "notch") dark(rrectPlane(cam.w, cam.h * 2, cam.h * 0.8), 0, top);
    else if (cam.kind === "dot") dark(new THREE.CircleGeometry(cam.r, 20), 0, top + cam.y);
    return { screen };
  };

  let screenMesh: THREE.Mesh;
  let floorY = 0;

  if (d.kind === "phone" || d.kind === "tablet") {
    screenMesh = display(root, b.d).screen;
    // volume / power keys on the right wall (positions as in the still renderer)
    for (const [fromTop, half] of [[0.25, 0.065], [0.41, 0.033]] as const) {
      const bt = new THREE.Mesh(geom(new THREE.BoxGeometry(0.7, b.h * half * 2, Math.max(0.5, b.d * 0.17))), metal);
      bt.position.set(b.w / 2, b.h * (0.5 - fromTop), -b.d / 2);
      root.add(bt);
    }
  } else if (d.kind === "laptop") {
    const l = d.laptop!;
    const hb = b.d - l.lid_t;
    const base = new THREE.Group();
    const baseMesh = new THREE.Mesh(geom(slab(b.w / 2, b.h / 2, b.corner_r, hb, b.edge_r)), metal);
    base.add(baseMesh);
    const deckTex = keyboardTexture(b.w, b.h, "#" + finish.getHexString());
    disposables.push(deckTex);
    const deck = new THREE.Mesh(geom(new THREE.PlaneGeometry(b.w - 2 * b.edge_r, b.h - 2 * b.edge_r)), new THREE.MeshPhysicalMaterial({ map: deckTex, metalness: 0.9, roughness: 0.4 }));
    disposables.push(deck.material as THREE.Material);
    deck.position.z = 0.02;
    // the texture is drawn for y-down plan coordinates: top of the canvas = back of the deck
    base.add(deck);
    base.rotation.x = -Math.PI / 2; // local z -> up, local y -> toward the back (-z)
    base.position.y = hb;
    root.add(base);
    const th = (l.open_deg * Math.PI) / 180;
    const lid = new THREE.Group();
    screenMesh = display(lid, l.lid_t).screen;
    lid.rotation.x = Math.PI / 2 - th;
    const u = new THREE.Vector3(0, Math.sin(th), Math.cos(th));
    lid.position.set(0, hb, -b.h / 2).addScaledVector(u, b.h / 2);
    root.add(lid);
    // keep the deck texture tied to the finish so recolouring stays consistent
    (root.userData.deck = { mesh: deck, redraw: (hex: string) => {
      const old = (deck.material as THREE.MeshPhysicalMaterial).map!;
      const nt = keyboardTexture(b.w, b.h, hex);
      (deck.material as THREE.MeshPhysicalMaterial).map = nt;
      old.dispose(); disposables.push(nt);
    } });
  } else {
    const s = d.stand!;
    const slabBottom = s.total_h - b.h;
    const disp = new THREE.Group();
    disp.position.y = slabBottom + b.h / 2;
    screenMesh = display(disp, b.d).screen;
    root.add(disp);
    const zc = -(s.foot_d - 45) / 2;
    const foot = new THREE.Mesh(geom(slab(s.foot_w / 2, s.foot_d / 2, 14, s.foot_t, 2)), metal);
    foot.rotation.x = -Math.PI / 2; foot.position.set(0, s.foot_t, zc);
    root.add(foot);
    const y0 = s.foot_t, z0 = zc - s.foot_d / 2 + 12, y1 = slabBottom + 30, z1 = -b.d - 6;
    const len = Math.hypot(y1 - y0, z1 - z0);
    const neck = new THREE.Mesh(geom(slab(s.foot_w / 2 * 0.62, len / 2, 6, 9, 2)), metal);
    // slab local y -> along the neck, z -> its normal (as in the still renderer)
    const dir = new THREE.Vector3(0, (y1 - y0) / len, (z1 - z0) / len);
    const nrm = new THREE.Vector3(0, -dir.z, dir.y);
    neck.matrixAutoUpdate = false;
    neck.matrix.makeBasis(new THREE.Vector3(1, 0, 0), dir, nrm).setPosition(0, (y0 + y1) / 2, (z0 + z1) / 2);
    root.add(neck);
  }

  // centre the model on the origin
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const wrap = new THREE.Group();
  root.position.sub(center);
  wrap.add(root);
  const size = box.getSize(new THREE.Vector3());
  floorY = -size.y / 2;

  const model: DeviceModel = {
    group: wrap, size, floorY,
    front: d.kind === "laptop" ? { w: b.w, h: Math.max(b.h * Math.sin(((d.laptop!.open_deg) * Math.PI) / 180), size.y) } : { w: b.w, h: d.kind === "imac" ? d.stand!.total_h : b.h },
    setFinish(hex) {
      const c = new THREE.Color(hex);
      metal.color.copy(c);
      (root.userData.deck as { redraw(h: string): void } | undefined)?.redraw(hex);
    },
    setGlare(k) { glareMat.opacity = 0.2 * k; glareMat.visible = k > 0; },
    setMap(tex, aspect, fit) {
      screenMat.map = tex;
      screenMat.color.set(tex ? 0xffffff : 0x111114);
      screenMat.needsUpdate = true;
      screenMesh.scale.set(1, 1, 1);
      if (!tex) return;
      const screenAspect = aw / ah;
      tex.repeat.set(1, 1); tex.offset.set(0, 0);
      if (fit === "cover") {
        if (aspect > screenAspect) { tex.repeat.x = screenAspect / aspect; tex.offset.x = (1 - tex.repeat.x) / 2; }
        else { tex.repeat.y = aspect / screenAspect; tex.offset.y = (1 - tex.repeat.y) / 2; }
      } else if (fit === "contain") {
        if (aspect > screenAspect) screenMesh.scale.y = screenAspect / aspect;
        else screenMesh.scale.x = aspect / screenAspect;
      }
    },
    dispose() { for (const o of disposables) o.dispose(); },
  };
  model.floorY = floorY;
  return model;
}
