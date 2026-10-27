//! Triangle meshes for devices, in millimetres (model space: x right, y up, z toward the viewer).
//!
//! Bodies are rounded rectangles extruded to their real thickness with a filleted edge profile and
//! smooth normals, so side walls, edge highlights and silhouettes are genuinely three-dimensional.

use crate::manifest::{Device, Kind};

pub type V3 = [f32; 3];
pub type M3 = [V3; 3]; // row-major

pub fn dot(a: V3, b: V3) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
pub fn scale(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}
pub fn norm(a: V3) -> V3 {
    let l = dot(a, a).sqrt().max(1e-12);
    scale(a, 1.0 / l)
}
pub fn mul_v(m: &M3, v: V3) -> V3 {
    [dot(m[0], v), dot(m[1], v), dot(m[2], v)]
}
pub fn mul_m(a: &M3, b: &M3) -> M3 {
    let mut r = [[0f32; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            r[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    r
}
pub fn rot_x(a: f32) -> M3 {
    let (s, c) = a.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}
pub fn rot_y(a: f32) -> M3 {
    let (s, c) = a.sin_cos();
    [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
}
pub fn rot_z(a: f32) -> M3 {
    let (s, c) = a.sin_cos();
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mat {
    /// Textured by the 2D face shader (uv in face pixels).
    Front,
    /// Metal in the finish colour.
    Metal,
    /// Laptop deck: keyboard and trackpad (uv in mm on the deck plane).
    Deck,
}

#[derive(Clone, Copy)]
pub struct Vert {
    pub p: V3,
    pub n: V3,
    pub uv: [f32; 2],
}

#[derive(Default)]
pub struct Mesh {
    pub verts: Vec<Vert>,
    pub tris: Vec<([u32; 3], Mat)>,
}

/// Local -> model transform: columns are the images of the local x, y, z axes.
#[derive(Clone, Copy)]
pub struct Xf {
    pub ex: V3,
    pub ey: V3,
    pub ez: V3,
    pub o: V3,
}

impl Xf {
    pub fn point(&self, p: V3) -> V3 {
        add(add(add(scale(self.ex, p[0]), scale(self.ey, p[1])), scale(self.ez, p[2])), self.o)
    }
    pub fn dir(&self, n: V3) -> V3 {
        add(add(scale(self.ex, n[0]), scale(self.ey, n[1])), scale(self.ez, n[2]))
    }
}

const CORNER_SEG: usize = 10;
const FILLET_SEG: usize = 5;

/// Closed rounded-rectangle outline (CCW seen from +z) with outward 2D normals.
fn outline(hx: f32, hy: f32, r: f32) -> Vec<([f32; 2], [f32; 2])> {
    let r = r.min(hx).min(hy).max(0.02);
    let mut pts = Vec::with_capacity(4 * (CORNER_SEG + 1));
    for (c, start) in [((hx - r, hy - r), 0.0f32), ((-(hx - r), hy - r), 90.0), ((-(hx - r), -(hy - r)), 180.0), ((hx - r, -(hy - r)), 270.0)] {
        for i in 0..=CORNER_SEG {
            let a = (start + 90.0 * i as f32 / CORNER_SEG as f32).to_radians();
            let n = [a.cos(), a.sin()];
            pts.push(([c.0 + r * n[0], c.1 + r * n[1]], n));
        }
    }
    pts
}

pub struct Extrusion {
    pub hw: f32,
    pub hh: f32,
    pub r: f32,
    pub depth: f32,
    pub e: f32,
    pub front: Mat,
    /// uv = (x, y) * uv_scale on the front face; y is flipped (face pixels are y-down) when `flip_v`.
    pub uv_scale: f32,
    pub flip_v: bool,
}

impl Mesh {
    fn push(&mut self, v: Vert) -> u32 {
        self.verts.push(v);
        (self.verts.len() - 1) as u32
    }

    /// Rounded-rectangle slab: front face at local z=0 facing +z, thickness toward -z.
    pub fn extrude(&mut self, x: &Extrusion, xf: &Xf) {
        let e = x.e.min(x.depth / 2.0 - 0.01).min(x.r - 0.25).max(0.0);
        // Rings from front to back: (inset, z, normal blend: [n2 weight, nz])
        let mut rings: Vec<(f32, f32, f32, f32)> = Vec::new();
        for j in 0..=FILLET_SEG {
            let a = (j as f32 / FILLET_SEG as f32) * std::f32::consts::FRAC_PI_2;
            rings.push((e - e * a.sin(), -e + e * a.cos(), a.sin(), a.cos()));
        }
        for j in 0..=FILLET_SEG {
            let b = (j as f32 / FILLET_SEG as f32) * std::f32::consts::FRAC_PI_2;
            rings.push((e - e * b.cos(), -(x.depth - e) - e * b.sin(), b.cos(), -b.sin()));
        }
        // front face fan from the first ring
        let mut ring_idx: Vec<Vec<u32>> = Vec::new();
        for (ri, &(inset, z, wn, wz)) in rings.iter().enumerate() {
            let o = outline(x.hw - inset, x.hh - inset, x.r - inset);
            let mut idx = Vec::with_capacity(o.len());
            for (p, n2) in o {
                let n = norm(xf.dir([n2[0] * wn, n2[1] * wn, wz]));
                let on_face = ri == 0;
                let uv = if on_face {
                    [p[0] * x.uv_scale, if x.flip_v { -p[1] } else { p[1] } * x.uv_scale]
                } else {
                    [0.0, 0.0]
                };
                idx.push(self.push(Vert { p: xf.point([p[0], p[1], z]), n, uv }));
            }
            ring_idx.push(idx);
        }
        let n_front = norm(xf.dir([0.0, 0.0, 1.0]));
        let n_back = scale(n_front, -1.0);
        let cuv = [0.0, 0.0];
        let fc = self.push(Vert { p: xf.point([0.0, 0.0, 0.0]), n: n_front, uv: cuv });
        let f0 = ring_idx[0].clone();
        let m = f0.len();
        for k in 0..m {
            self.tris.push(([fc, f0[k], f0[(k + 1) % m]], x.front));
        }
        // side wall quads between consecutive rings (outward-facing winding)
        for w in ring_idx.windows(2) {
            for k in 0..m {
                let (a, b, c, d) = (w[0][k], w[0][(k + 1) % m], w[1][(k + 1) % m], w[1][k]);
                self.tris.push(([a, d, c], Mat::Metal));
                self.tris.push(([a, c, b], Mat::Metal));
            }
        }
        // back face (duplicate verts with the back normal)
        let last = ring_idx.last().unwrap().clone();
        let bc = self.push(Vert { p: xf.point([0.0, 0.0, -x.depth]), n: n_back, uv: cuv });
        let back: Vec<u32> = last
            .iter()
            .map(|&i| {
                let v = self.verts[i as usize];
                self.push(Vert { n: n_back, ..v })
            })
            .collect();
        for k in 0..m {
            self.tris.push(([bc, back[(k + 1) % m], back[k]], Mat::Metal));
        }
    }

    /// Axis-aligned (in local space) box with flat normals.
    pub fn cuboid(&mut self, c: V3, h: V3, xf: &Xf, mat: Mat) {
        let faces: [(V3, V3, V3); 6] = [
            ([1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]),
            ([-1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 1.0, 0.0]),
            ([0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 0.0, 0.0]),
            ([0.0, -1.0, 0.0], [1.0, 0.0, 0.0], [0.0, 0.0, 1.0]),
            ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]),
            ([0.0, 0.0, -1.0], [0.0, 1.0, 0.0], [1.0, 0.0, 0.0]),
        ];
        for (n, u, v) in faces {
            let corner = |su: f32, sv: f32| {
                let p = [
                    c[0] + h[0] * (n[0] + su * u[0] + sv * v[0]),
                    c[1] + h[1] * (n[1] + su * u[1] + sv * v[1]),
                    c[2] + h[2] * (n[2] + su * u[2] + sv * v[2]),
                ];
                xf.point(p)
            };
            let nn = norm(xf.dir(n));
            let q: Vec<u32> = [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)]
                .iter()
                .map(|&(su, sv)| self.push(Vert { p: corner(su, sv), n: nn, uv: [0.0, 0.0] }))
                .collect();
            // choose the winding so the geometric normal agrees with n
            let g = {
                let (a, b, c2) = (self.verts[q[0] as usize].p, self.verts[q[1] as usize].p, self.verts[q[2] as usize].p);
                let (e1, e2) = (sub(b, a), sub(c2, a));
                [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
            };
            if dot(g, nn) >= 0.0 {
                self.tris.push(([q[0], q[1], q[2]], mat));
                self.tris.push(([q[0], q[2], q[3]], mat));
            } else {
                self.tris.push(([q[0], q[2], q[1]], mat));
                self.tris.push(([q[0], q[3], q[2]], mat));
            }
        }
    }

    pub fn bounds(&self) -> (V3, V3) {
        let mut lo = [f32::MAX; 3];
        let mut hi = [f32::MIN; 3];
        for v in &self.verts {
            for i in 0..3 {
                lo[i] = lo[i].min(v.p[i]);
                hi[i] = hi[i].max(v.p[i]);
            }
        }
        (lo, hi)
    }
}

/// Builds the full 3D model of a device (model space, mm).
pub fn build(d: &Device) -> Mesh {
    let mut m = Mesh::default();
    let b = &d.body;
    let ppm = d.derived().ppm;
    let ident = Xf { ex: [1.0, 0.0, 0.0], ey: [0.0, 1.0, 0.0], ez: [0.0, 0.0, 1.0], o: [0.0, 0.0, 0.0] };
    let front = |hw: f32, hh: f32, depth: f32| Extrusion { hw, hh, r: d.corner_r_3d(), depth, e: b.edge_r, front: Mat::Front, uv_scale: ppm, flip_v: true };
    match d.kind {
        Kind::Phone | Kind::Tablet => {
            m.extrude(&front(b.w / 2.0, b.h / 2.0, b.d), &ident);
            // power and volume buttons on the right side wall (or painted by the wall shader)
            let t = 0.5;
            for (from_top, half) in [(0.25, 0.065), (0.41, 0.033)] {
                m.cuboid([b.w / 2.0 - t * 0.2, b.h * (0.5 - from_top), -b.d / 2.0], [t, b.h * half, (b.d * 0.17).max(0.5)], &ident, Mat::Metal);
            }
        }
        Kind::Laptop => {
            let l = d.laptop.as_ref().unwrap();
            let hb = b.d - l.lid_t;
            // base: top face (deck) up; plan y runs toward the back (-z)
            let base_xf = Xf { ex: [1.0, 0.0, 0.0], ey: [0.0, 0.0, -1.0], ez: [0.0, 1.0, 0.0], o: [0.0, hb, 0.0] };
            m.extrude(&Extrusion { hw: b.w / 2.0, hh: b.h / 2.0, r: b.corner_r, depth: hb, e: b.edge_r, front: Mat::Deck, uv_scale: 1.0, flip_v: false }, &base_xf);
            // lid hinged on the base's rear edge, opened by open_deg
            let th = l.open_deg.to_radians();
            let u = [0.0, th.sin(), th.cos()];
            let n = [0.0, -th.cos(), th.sin()];
            let hinge = [0.0, hb, -b.h / 2.0];
            let lid_xf = Xf { ex: [1.0, 0.0, 0.0], ey: u, ez: n, o: add(hinge, scale(u, b.h / 2.0)) };
            m.extrude(&front(b.w / 2.0, b.h / 2.0, l.lid_t), &lid_xf);
        }
        Kind::Imac => {
            let s = d.stand.as_ref().unwrap();
            let slab_bottom = s.total_h - b.h;
            let slab_xf = Xf { o: [0.0, slab_bottom + b.h / 2.0, 0.0], ..ident };
            m.extrude(&front(b.w / 2.0, b.h / 2.0, b.d), &slab_xf);
            // foot plate on the desk, extending behind and slightly in front of the display
            let zc = -(s.foot_d - 45.0) / 2.0 - 0.0;
            let foot_xf = Xf { ex: [1.0, 0.0, 0.0], ey: [0.0, 0.0, -1.0], ez: [0.0, 1.0, 0.0], o: [0.0, s.foot_t, zc + 0.0] };
            m.extrude(&Extrusion { hw: s.foot_w / 2.0, hh: s.foot_d / 2.0, r: 14.0, depth: s.foot_t, e: 2.0, front: Mat::Metal, uv_scale: 1.0, flip_v: false }, &foot_xf);
            // neck: a plate rising from the foot's rear edge to the back of the display
            let (y0, z0) = (s.foot_t, zc - s.foot_d / 2.0 + 12.0);
            let (y1, z1) = (slab_bottom + 30.0, -b.d - 6.0);
            let len = ((y1 - y0).powi(2) + (z1 - z0).powi(2)).sqrt();
            let dir = [0.0, (y1 - y0) / len, (z1 - z0) / len];
            let nrm = [0.0, -dir[2], dir[1]];
            let neck_xf = Xf { ex: [1.0, 0.0, 0.0], ey: dir, ez: nrm, o: [0.0, (y0 + y1) / 2.0, (z0 + z1) / 2.0] };
            m.extrude(&Extrusion { hw: s.foot_w / 2.0 * 0.62, hh: len / 2.0, r: 6.0, depth: 9.0, e: 2.0, front: Mat::Metal, uv_scale: 1.0, flip_v: false }, &neck_xf);
        }
    }
    m
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{bundled, find};

    #[test]
    fn phone_mesh_matches_real_dimensions() {
        let man = bundled();
        let d = find(&man, "galaxy-s24-ultra").unwrap();
        let (lo, hi) = build(d).bounds();
        // body bounds plus 0.5mm button protrusion on the right
        assert!((hi[1] - lo[1] - d.body.h).abs() < 0.01);
        assert!((hi[2] - lo[2] - d.body.d).abs() < 0.01);
        assert!((hi[0] - lo[0] - d.body.w - 0.4).abs() < 0.6);
    }

    #[test]
    fn laptop_open_height_is_plausible() {
        let man = bundled();
        let d = find(&man, "macbook-pro-14").unwrap();
        let (lo, hi) = build(d).bounds();
        assert!(lo[1].abs() < 0.01, "sits on the desk");
        // lid leaning back 106 degrees stands about 20cm tall
        assert!(hi[1] > 190.0 && hi[1] < 230.0, "{}", hi[1]);
        assert!((hi[0] - lo[0] - d.body.w).abs() < 0.01);
    }

    #[test]
    fn imac_total_height_matches_spec() {
        let man = bundled();
        let d = find(&man, "imac-24").unwrap();
        let (lo, hi) = build(d).bounds();
        assert!(lo[1].abs() < 0.01);
        assert!((hi[1] - 461.0).abs() < 0.01);
    }
}
