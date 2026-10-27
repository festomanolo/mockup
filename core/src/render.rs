//! Renders a device with a screenshot.
//!
//! * Phone/tablet portrait + landscape: a fast analytic 2D path (orthographic front view, where
//!   thickness is invisible anyway).
//! * Everything else: a real 3D model (see `mesh`) drawn by the tiled rasterizer in `raster`.

use crate::front::{cover, over, prepare_shot, sd_rrect, FrontSpec};
pub use crate::front::{Fit, Image};
use crate::manifest::{parse_hex, Device, Kind};
use crate::mesh::{self, mul_m, rot_x, rot_y, rot_z, M3};
use crate::raster::{project, rasterize, Camera, Shading};
use crate::wall::{Wall, BUTTONS};

pub const MAX_SIDE: u32 = 12_000;
pub const MAX_PIXELS: u64 = 80_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Orientation {
    Portrait,
    Landscape,
    Right,
    Left,
    Front,
}

impl Orientation {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "portrait" => Self::Portrait,
            "landscape" => Self::Landscape,
            "right" => Self::Right,
            "left" => Self::Left,
            "front" => Self::Front,
            _ => return None,
        })
    }
    fn name(self) -> &'static str {
        match self {
            Self::Portrait => "portrait",
            Self::Landscape => "landscape",
            Self::Right => "right",
            Self::Left => "left",
            Self::Front => "front",
        }
    }
}

pub struct Output {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

pub struct Params<'a> {
    pub finish: usize,
    pub orientation: Orientation,
    pub fit: Fit,
    /// Multiplier on the native size (screen at 1:1 screen pixels).
    pub scale: f32,
    pub screenshot: Option<Image<'a>>,
}

fn is_flat(d: &Device, o: Orientation) -> bool {
    matches!(d.kind, Kind::Phone | Kind::Tablet) && matches!(o, Orientation::Portrait | Orientation::Landscape)
}

/// Camera rotation for a given view. Angles are tuned so thickness reads clearly.
fn camera(d: &Device, o: Orientation) -> Camera {
    let (rot, dist_k): (M3, f32) = match (d.kind, o) {
        // phones/tablets lying on a desk, seen from above at an angle (like MockUPhone's tilted views)
        (Kind::Phone | Kind::Tablet, Orientation::Right) => (mul_m(&rot_x(-0.95), &mul_m(&rot_z(0.62), &rot_y(0.0))), 9.0),
        (Kind::Phone | Kind::Tablet, Orientation::Left) => (mul_m(&rot_x(-0.95), &mul_m(&rot_z(-0.62), &rot_y(0.0))), 9.0),
        (_, Orientation::Right) => (mul_m(&rot_x(0.2), &rot_y(0.62)), 6.0),
        (_, Orientation::Left) => (mul_m(&rot_x(0.2), &rot_y(-0.62)), 6.0),
        _ => (rot_x(if d.kind == Kind::Imac { 0.05 } else { 0.2 }), 6.0),
    };
    let size = d.body.w.max(d.body.h).max(d.stand.as_ref().map_or(0.0, |s| s.total_h));
    Camera { rot, dist: size * dist_k }
}

fn px_per_mm(d: &Device, scale: f32) -> f32 {
    d.derived().ppm * scale
}

fn check(d: &Device, o: Orientation, scale: f32) -> Result<(), String> {
    if !(scale.is_finite() && scale > 0.0) {
        return Err("scale must be positive".into());
    }
    if !d.orientations.iter().any(|x| x == o.name()) {
        return Err(format!("{} does not support the '{}' orientation", d.name, o.name()));
    }
    Ok(())
}

const FLAT_MARGIN_MM: f32 = 0.8;

type Quad = [(f64, f64); 4];

fn flat_layout(d: &Device, o: Orientation, scale: f32) -> Result<(Quad, Quad, u32, u32), String> {
    let ppm = px_per_mm(d, 1.0) as f64;
    let m = FLAT_MARGIN_MM as f64 * ppm;
    let (wf, hf) = (d.body.w as f64 * ppm + 2.0 * m, d.body.h as f64 * ppm + 2.0 * m);
    let src = [(0.0, 0.0), (wf, 0.0), (wf, hf), (0.0, hf)];
    let (dst, ow, oh) = match o {
        Orientation::Landscape => ([(hf, 0.0), (hf, wf), (0.0, wf), (0.0, 0.0)], hf, wf),
        _ => (src, wf, hf),
    };
    let s = scale as f64;
    let (w, h) = ((ow * s).ceil(), (oh * s).ceil());
    if !(w >= 1.0 && h >= 1.0) || w > MAX_SIDE as f64 || h > MAX_SIDE as f64 || w * h > MAX_PIXELS as f64 {
        return Err(format!("output {}x{} exceeds the size limit", w, h));
    }
    Ok((src, dst.map(|(x, y)| (x * s, y * s)), w as u32, h as u32))
}

pub fn output_size(d: &Device, o: Orientation, scale: f32) -> Result<(u32, u32), String> {
    check(d, o, scale)?;
    if is_flat(d, o) {
        return flat_layout(d, o, scale).map(|(_, _, w, h)| (w, h));
    }
    let mesh = mesh::build(d);
    project(&mesh, &camera(d, o), px_per_mm(d, scale), MAX_SIDE, MAX_PIXELS).map(|p| (p.width, p.height))
}

pub fn render(d: &Device, p: &Params) -> Result<Output, String> {
    check(d, p.orientation, p.scale)?;
    let (sw, sh) = (d.screen.w as f32, d.screen.h as f32);
    let shot = match &p.screenshot {
        Some(img) => Some(prepare_shot(img, p.fit, sw, sh, sw * p.scale)?),
        None => None,
    };
    let spec = FrontSpec::new(d, p.finish, is_flat(d, p.orientation), shot)?;
    let metal = parse_hex(&d.finishes[p.finish].color).ok_or("bad finish color")?;
    if is_flat(d, p.orientation) {
        return render_flat(d, p, &spec, metal);
    }
    let mesh = mesh::build(d);
    let proj = project(&mesh, &camera(d, p.orientation), px_per_mm(d, p.scale), MAX_SIDE, MAX_PIXELS)?;
    let shading = Shading { front: spec, metal, deck: (d.body.w, d.body.h) };
    let data = rasterize(&proj, &shading);
    Ok(Output { width: proj.width, height: proj.height, data })
}

fn render_flat(d: &Device, p: &Params, spec: &FrontSpec, metal: [f32; 3]) -> Result<Output, String> {
    let (src, _, ow, oh) = flat_layout(d, p.orientation, p.scale)?;
    let ppm = px_per_mm(d, 1.0);
    let s = p.scale;
    let (wf, hf) = (src[2].0 as f32, src[2].1 as f32);
    let (cx, cy) = (wf / 2.0, hf / 2.0);
    let (bhw, bhh) = spec.body_half();
    let btn = metal.map(|c| c * 0.8);
    let buttons: [(f32, f32); 2] = [(0.25, 0.065), (0.41, 0.033)];
    let landscape = p.orientation == Orientation::Landscape;
    let fp = 1.0 / s;
    let mut data = vec![0u8; (ow as usize) * (oh as usize) * 4];
    for y in 0..oh {
        for x in 0..ow {
            // axis-aligned views invert exactly without a projective transform
            let (px_, py_) = ((x as f32 + 0.5) / s, (y as f32 + 0.5) / s);
            let (u, v) = if landscape { (py_ - cx, hf - px_ - cy) } else { (px_ - cx, py_ - cy) };
            if u.abs() > bhw + 4.0 * ppm || v.abs() > bhh + 4.0 * ppm {
                continue;
            }
            let mut px = [0f32; 4];
            // side buttons peek out from under the body on the right edge
            if u > bhw - ppm {
                for (from_top, half) in buttons {
                    let by = (from_top - 0.5) * 2.0 * bhh;
                    let dd = sd_rrect(u, v, bhw - 0.1 * ppm, by, 0.5 * ppm, half * 2.0 * bhh, 0.3 * ppm);
                    over(&mut px, btn, cover(dd, fp));
                }
            }
            let f = spec.shade(u, v, fp, true);
            let k = 1.0 - f[3];
            for i in 0..4 {
                px[i] = f[i] + px[i] * k;
            }
            let a = px[3];
            if a > 0.0 {
                let o = ((y * ow + x) * 4) as usize;
                for c in 0..3 {
                    data[o + c] = ((px[c] / a).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                }
                data[o + 3] = (a.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        }
    }
    Ok(Output { width: ow, height: oh, data })
}
