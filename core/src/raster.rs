//! Tiled, z-buffered triangle rasterizer with 2x2 supersampling.
//!
//! Pass 1 writes a visibility buffer (triangle id + screen barycentrics) per sub-sample inside a
//! small tile; pass 2 shades. A pixel whose four sub-samples hit the same triangle is shaded once,
//! so the (comparatively expensive) face shader runs about once per pixel and extra only on edges.

use crate::front::{sd_rrect, FrontSpec};
use crate::mesh::{dot, norm, Mat, Mesh, M3, V3};
use crate::wall::Wall;

const SS: usize = 2;
const TS: usize = 32; // tile size in output pixels
const TSS: usize = TS * SS;
const NONE: u32 = u32::MAX;

pub struct Camera {
    pub rot: M3,
    /// Eye distance from the model centre, mm.
    pub dist: f32,
}

#[derive(Clone)]
pub struct STri {
    x: [f32; 3],
    y: [f32; 3],
    iw: [f32; 3],
    n: [V3; 3],
    uv: [[f32; 2]; 3],
    /// Model-space positions and normals (for the wall shader).
    mp: [V3; 3],
    mn: [V3; 3],
    mat: Mat,
    inv_area: f32,
    /// Face-unit footprint of one output pixel, measured once at the triangle centre.
    fp: f32,
}

impl STri {
    /// Screen-space barycentrics at a sub-sample position (valid outside the triangle too).
    #[inline]
    fn lam(&self, px: f32, py: f32) -> [f32; 3] {
        let e = |a: usize, b: usize| (self.x[b] - self.x[a]) * (py - self.y[a]) - (self.y[b] - self.y[a]) * (px - self.x[a]);
        [e(1, 2) * self.inv_area, e(2, 0) * self.inv_area, e(0, 1) * self.inv_area]
    }

    #[inline]
    fn persp(&self, l: [f32; 3]) -> [f32; 3] {
        let w = [l[0] * self.iw[0], l[1] * self.iw[1], l[2] * self.iw[2]];
        let s = (w[0] + w[1] + w[2]).max(1e-20);
        [w[0] / s, w[1] / s, w[2] / s]
    }

    #[inline]
    fn uv_at(&self, b: [f32; 3]) -> [f32; 2] {
        [0, 1].map(|k| b[0] * self.uv[0][k] + b[1] * self.uv[1][k] + b[2] * self.uv[2][k])
    }

    #[inline]
    fn normal_at(&self, b: [f32; 3]) -> V3 {
        norm(lerp3(&self.n, b))
    }
}

#[inline]
fn lerp3(v: &[V3; 3], b: [f32; 3]) -> V3 {
    [0, 1, 2].map(|k| b[0] * v[0][k] + b[1] * v[1][k] + b[2] * v[2][k])
}

pub struct Projected {
    pub tris: Vec<STri>,
    pub width: u32,
    pub height: u32,
}

/// Projects the mesh with a weak-perspective camera; `px_per_mm` sets the output scale.
pub fn project(mesh: &Mesh, cam: &Camera, px_per_mm: f32, max_side: u32, max_pixels: u64) -> Result<Projected, String> {
    let (lo, hi) = mesh.bounds();
    let centre = [(lo[0] + hi[0]) / 2.0, (lo[1] + hi[1]) / 2.0, (lo[2] + hi[2]) / 2.0];
    let view = |p: V3| -> (f32, f32, f32) {
        let q = crate::mesh::mul_v(&cam.rot, [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]]);
        let w = cam.dist - q[2];
        let k = cam.dist / w;
        (q[0] * k, -q[1] * k, 1.0 / w)
    };
    let pv: Vec<(f32, f32, f32)> = mesh.verts.iter().map(|v| view(v.p)).collect();
    let (mut minx, mut miny, mut maxx, mut maxy) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for &(x, y, _) in &pv {
        minx = minx.min(x);
        maxx = maxx.max(x);
        miny = miny.min(y);
        maxy = maxy.max(y);
    }
    let pad = 2.0;
    let (fw, fh) = ((maxx - minx) * px_per_mm + 2.0 * pad, (maxy - miny) * px_per_mm + 2.0 * pad);
    let (w, h) = (fw.ceil(), fh.ceil());
    if !(w >= 1.0 && h >= 1.0) || w > max_side as f32 || h > max_side as f32 || (w as f64) * (h as f64) > max_pixels as f64 {
        return Err(format!("output {}x{} exceeds the size limit", w, h));
    }
    let nview = |n: V3| crate::mesh::mul_v(&cam.rot, n);
    let mut tris = Vec::with_capacity(mesh.tris.len());
    for &([a, b, c], mat) in &mesh.tris {
        let idx = [a as usize, b as usize, c as usize];
        let sx = idx.map(|i| ((pv[i].0 - minx) * px_per_mm + pad) * SS as f32);
        let sy = idx.map(|i| ((pv[i].1 - miny) * px_per_mm + pad) * SS as f32);
        let area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
        if area >= -1e-6 {
            continue; // back-facing or degenerate
        }
        tris.push(STri {
            x: sx,
            y: sy,
            iw: idx.map(|i| pv[i].2),
            n: idx.map(|i| nview(mesh.verts[i].n)),
            uv: idx.map(|i| mesh.verts[i].uv),
            mat,
            inv_area: 1.0 / area,
            fp: 1.0,
        });
        let t = tris.last_mut().unwrap();
        if mat != Mat::Metal {
            let (cx, cy) = ((t.x[0] + t.x[1] + t.x[2]) / 3.0, (t.y[0] + t.y[1] + t.y[2]) / 3.0);
            let uv = t.uv_at(t.persp(t.lam(cx, cy)));
            let ub = t.uv_at(t.persp(t.lam(cx + SS as f32, cy)));
            let vb = t.uv_at(t.persp(t.lam(cx, cy + SS as f32)));
            t.fp = (ub[0] - uv[0]).hypot(ub[1] - uv[1]).max((vb[0] - uv[0]).hypot(vb[1] - uv[1])).max(1e-3);
        }
    }
    Ok(Projected { tris, width: w as u32, height: h as u32 })
}

pub struct Shading {
    pub front: FrontSpec,
    pub metal: [f32; 3],
    /// Deck plane size in mm (width, depth).
    pub deck: (f32, f32),
}

const LIGHT: V3 = [-0.40, 0.62, 0.68];

fn metal(base: [f32; 3], n: V3) -> [f32; 3] {
    let l = norm(LIGHT);
    let ndl = dot(n, l).max(0.0);
    let h = norm([l[0], l[1], l[2] + 1.0]);
    let spec = dot(n, h).max(0.0).powi(28) * 0.30;
    let rim = (1.0 - n[2].abs()).powi(3) * 0.10;
    base.map(|c| (c * (0.38 + 0.66 * ndl + rim) + spec).clamp(0.0, 1.0))
}

/// Laptop deck: keyboard well with key grid, and trackpad. (x, y) in mm from deck centre, y toward the back.
fn deck(base: [f32; 3], x: f32, y: f32, dims: (f32, f32), fp: f32) -> [f32; 3] {
    let (w, d) = dims;
    let mut col = base;
    let kw = w * 0.93;
    let (top, kh) = (d / 2.0 - 0.06 * d, 0.45 * d);
    let well = sd_rrect(x, y, 0.0, top - kh / 2.0, kw / 2.0, kh / 2.0, 2.0);
    let wa = (0.5 - well / fp).clamp(0.0, 1.0);
    if wa > 0.0 {
        // key cells: 15 columns x 6 rows (function row is half height)
        let rows = 5.5;
        let row_h = kh / rows;
        let ry = (top - y) / row_h; // 0 at top
        let (row, in_row) = if ry < 0.5 { (0.0, ry / 0.5) } else { (1.0 + (ry - 0.5).floor(), (ry - 0.5).fract()) };
        let cols = 15.0;
        let cw = kw / cols;
        let cx = (x + kw / 2.0) / cw;
        let in_col = cx.fract();
        let (gx, gy) = ((0.5 - in_col).abs() * 2.0, (0.5 - in_row).abs() * 2.0);
        let _ = row;
        let key = sd_rrect(gx, gy, 0.0, 0.0, 0.9, 0.9, 0.25) * 0.5 * cw.min(row_h);
        let ka = (0.5 - key / fp).clamp(0.0, 1.0);
        let well_rgb = [0.025, 0.025, 0.03];
        let key_rgb = [0.11, 0.11, 0.125];
        let mix = |a: [f32; 3], b: [f32; 3], t: f32| [0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t);
        let inside = mix(well_rgb, key_rgb, ka);
        col = mix(col, inside, wa);
    }
    // trackpad
    let (tw, th) = (w * 0.5, d * 0.32);
    let tcy = top - kh - d * 0.045 - th / 2.0;
    let tp = sd_rrect(x, y, 0.0, tcy, tw / 2.0, th / 2.0, 3.0);
    let edge = (0.5 - (tp.abs() - 0.18) / fp).clamp(0.0, 1.0) * 0.18;
    let ta = (0.5 - tp / fp).clamp(0.0, 1.0);
    col = [0, 1, 2].map(|i| (col[i] * (1.0 - 0.06 * ta) * (1.0 - edge)).clamp(0.0, 1.0));
    col
}

fn shade_sample(t: &STri, l: [f32; 3], sh: &Shading) -> [f32; 3] {
    let b = t.persp(l);
    let n = t.normal_at(b);
    match t.mat {
        Mat::Metal => metal(sh.metal, n),
        Mat::Front | Mat::Deck => {
            let uv = t.uv_at(b);
            let fp = t.fp;
            if t.mat == Mat::Front {
                let c = sh.front.shade(uv[0], uv[1], fp, false);
                let a = c[3].max(1e-6);
                [c[0] / a, c[1] / a, c[2] / a]
            } else {
                let lit = 0.9 + 0.1 * dot(n, norm(LIGHT)).max(0.0);
                deck(sh.metal, uv[0], uv[1], sh.deck, fp).map(|c| (c * lit).clamp(0.0, 1.0))
            }
        }
    }
}

pub fn rasterize(p: &Projected, sh: &Shading) -> Vec<u8> {
    let (w, h) = (p.width as usize, p.height as usize);
    let mut out = vec![0u8; w * h * 4];
    let (tx_n, ty_n) = (w.div_ceil(TS), h.div_ceil(TS));
    let mut bins: Vec<Vec<u32>> = vec![Vec::new(); tx_n * ty_n];
    for (i, t) in p.tris.iter().enumerate() {
        let f = |v: &[f32; 3]| (v.iter().cloned().fold(f32::MAX, f32::min), v.iter().cloned().fold(f32::MIN, f32::max));
        let ((x0, x1), (y0, y1)) = (f(&t.x), f(&t.y));
        let tx0 = ((x0 / TSS as f32).floor().max(0.0)) as usize;
        let tx1 = ((x1 / TSS as f32).floor().max(0.0) as usize).min(tx_n - 1);
        let ty0 = ((y0 / TSS as f32).floor().max(0.0)) as usize;
        let ty1 = ((y1 / TSS as f32).floor().max(0.0) as usize).min(ty_n - 1);
        for ty in ty0..=ty1 {
            for tx in tx0..=tx1 {
                bins[ty * tx_n + tx].push(i as u32);
            }
        }
    }
    let mut zbuf = vec![0f32; TSS * TSS];
    let mut ids = vec![NONE; TSS * TSS];
    let mut lams = vec![[0f32; 2]; TSS * TSS];
    for ty in 0..ty_n {
        for tx in 0..tx_n {
            let bin = &bins[ty * tx_n + tx];
            if bin.is_empty() {
                continue;
            }
            zbuf.fill(0.0);
            ids.fill(NONE);
            let (ox, oy) = ((tx * TSS) as f32, (ty * TSS) as f32);
            for &ti in bin {
                let t = &p.tris[ti as usize];
                let minx = (t.x.iter().cloned().fold(f32::MAX, f32::min) - ox).floor().max(0.0) as usize;
                let maxx = ((t.x.iter().cloned().fold(f32::MIN, f32::max) - ox).ceil().max(0.0) as usize).min(TSS - 1);
                let miny = (t.y.iter().cloned().fold(f32::MAX, f32::min) - oy).floor().max(0.0) as usize;
                let maxy = ((t.y.iter().cloned().fold(f32::MIN, f32::max) - oy).ceil().max(0.0) as usize).min(TSS - 1);
                // per row, intersect the three half-planes analytically so only covered sub-samples are visited
                let edges = [(1usize, 2usize), (2, 0), (0, 1)].map(|(a, b)| {
                    let (dx, dy) = (t.x[b] - t.x[a], t.y[b] - t.y[a]);
                    // e(px, py) = dx*(py - ya) - dy*(px - xa) = -dy*px + (dx*(py - ya) + dy*xa)
                    (-dy, dx, t.y[a], dy * t.x[a])
                });
                for sy in miny..=maxy {
                    let py = oy + sy as f32 + 0.5;
                    let (mut lo, mut hi) = (minx as f32 + ox, maxx as f32 + ox + 1.0);
                    for &(a, dx, ya, c0) in &edges {
                        let c = dx * (py - ya) + c0;
                        // inside <=> e*inv_area >= 0 <=> e <= 0 (inv_area < 0): a*px + c <= 0
                        if a > 0.0 {
                            hi = hi.min((-c / a) + 0.0);
                        } else if a < 0.0 {
                            lo = lo.max(-c / a);
                        } else if c > 0.0 {
                            hi = lo - 1.0;
                        }
                    }
                    let x_start = ((lo - ox - 0.5).ceil().max(minx as f32)) as usize;
                    let x_end = ((hi - ox - 0.5).floor().min(maxx as f32)) as isize;
                    if x_end < x_start as isize {
                        continue;
                    }
                    for sx in x_start..=(x_end as usize) {
                        let px = ox + sx as f32 + 0.5;
                        let l = t.lam(px, py);
                        let z = l[0] * t.iw[0] + l[1] * t.iw[1] + l[2] * t.iw[2];
                        let i = sy * TSS + sx;
                        if z > zbuf[i] {
                            zbuf[i] = z;
                            ids[i] = ti;
                            lams[i] = [l[1].max(0.0), l[2].max(0.0)];
                        }
                    }
                }
            }
            // shading pass
            for py in 0..TS {
                let gy = ty * TS + py;
                if gy >= h {
                    break;
                }
                for pxl in 0..TS {
                    let gx = tx * TS + pxl;
                    if gx >= w {
                        break;
                    }
                    let subs: [usize; 4] = [
                        (py * SS) * TSS + pxl * SS,
                        (py * SS) * TSS + pxl * SS + 1,
                        (py * SS + 1) * TSS + pxl * SS,
                        (py * SS + 1) * TSS + pxl * SS + 1,
                    ];
                    let sid = subs.map(|i| ids[i]);
                    let (cx, cy) = (ox + (pxl * SS) as f32 + SS as f32 / 2.0, oy + (py * SS) as f32 + SS as f32 / 2.0);
                    let mut acc = [0f32; 3];
                    let mut count = 0.0;
                    let mut uniform = false;
                    if sid[0] != NONE && sid.iter().all(|&s| s == sid[0]) {
                        let t = &p.tris[sid[0] as usize];
                        acc = shade_sample(t, t.lam(cx, cy), sh);
                        count = 4.0;
                        uniform = true;
                    } else {
                        for (k, &i) in subs.iter().enumerate() {
                            if sid[k] == NONE {
                                continue;
                            }
                            let t = &p.tris[sid[k] as usize];
                            let c = shade_sample(t, [1.0 - lams[i][0] - lams[i][1], lams[i][0], lams[i][1]], sh);
                            for j in 0..3 {
                                acc[j] += c[j];
                            }
                            count += 1.0;
                        }
                    }
                    if count == 0.0 {
                        continue;
                    }
                    let o = (gy * w + gx) * 4;
                    let a = count / 4.0;
                    let div = if uniform { 1.0 } else { count };
                    for j in 0..3 {
                        let c = acc[j] / div;
                        out[o + j] = (c.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                    }
                    out[o + 3] = (a * 255.0 + 0.5) as u8;
                }
            }
        }
    }
    out
}
