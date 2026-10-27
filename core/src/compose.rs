//! Final composition: background (transparent / solid / gradient), padding and soft shadows
//! derived from the rendered device's own alpha silhouette.
//!
//! Sizes are linear in the device size (padding and shadow are fractions of its long side), so a
//! caller can pick a render scale for a target final size with `final_size` at scale 1.

use crate::manifest::parse_hex;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Bg {
    Transparent,
    Solid { color: String },
    /// CSS-style angle: 0 = to top, 90 = to right, 180 = to bottom.
    Linear { from: String, to: String, #[serde(default = "default_angle")] angle: f32 },
}

fn default_angle() -> f32 {
    135.0
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShadowKind {
    None,
    Soft,
    Floating,
    Contact,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Style {
    pub bg: Bg,
    /// Extra margin around the device as a fraction of its long side (0..0.5).
    pub padding: f32,
    pub shadow: ShadowKind,
    /// 0..1
    pub strength: f32,
}

impl Default for Style {
    fn default() -> Self {
        Self { bg: Bg::Transparent, padding: 0.0, shadow: ShadowKind::None, strength: 0.6 }
    }
}

pub fn parse_style(json: &str) -> Result<Style, String> {
    let s: Style = if json.trim().is_empty() { Style::default() } else { serde_json::from_str(json).map_err(|e| format!("invalid style: {e}"))? };
    if !(0.0..=0.5).contains(&s.padding) || !(0.0..=1.0).contains(&s.strength) {
        return Err("padding must be 0..0.5 and strength 0..1".into());
    }
    match &s.bg {
        Bg::Solid { color } => {
            parse_hex(color).ok_or("bad background color")?;
        }
        Bg::Linear { from, to, angle } => {
            parse_hex(from).ok_or("bad gradient color")?;
            parse_hex(to).ok_or("bad gradient color")?;
            if !angle.is_finite() {
                return Err("bad gradient angle".into());
            }
        }
        Bg::Transparent => {}
    }
    Ok(s)
}

impl Style {
    /// True when composing would leave the device image untouched.
    pub fn is_identity(&self) -> bool {
        self.bg == Bg::Transparent && self.padding == 0.0 && self.shadow == ShadowKind::None
    }
}

/// (blur, offset_y, opacity) as fractions of the device's long side.
fn layers(k: ShadowKind) -> &'static [(f32, f32, f32)] {
    match k {
        ShadowKind::None => &[],
        ShadowKind::Soft => &[(0.035, 0.022, 0.32), (0.007, 0.004, 0.30)],
        ShadowKind::Floating => &[(0.05, 0.075, 0.30), (0.012, 0.02, 0.22)],
        ShadowKind::Contact => &[(0.006, 0.003, 0.45), (0.02, 0.008, 0.25)],
    }
}

fn pad_fraction(s: &Style) -> f32 {
    let reach = layers(s.shadow).iter().map(|&(b, oy, _)| b * 1.6 + oy.abs()).fold(0.0, f32::max);
    s.padding.max(reach)
}

/// Returns (final width, final height, padding px).
pub fn final_layout(w: u32, h: u32, s: &Style) -> (u32, u32, u32) {
    if s.is_identity() {
        return (w, h, 0);
    }
    let p = (pad_fraction(s) * w.max(h) as f32).round() as u32;
    (w + 2 * p, h + 2 * p, p)
}

fn box_blur(buf: &mut [f32], w: usize, h: usize, r: usize) {
    if r == 0 {
        return;
    }
    let mut tmp = vec![0f32; w.max(h)];
    let norm = 1.0 / (2 * r + 1) as f32;
    for y in 0..h {
        let row = &mut buf[y * w..(y + 1) * w];
        let mut acc: f32 = (0..=r.min(w - 1)).map(|i| row[i]).sum::<f32>() + row[0] * r as f32;
        for x in 0..w {
            tmp[x] = acc * norm;
            let add = row[(x + r + 1).min(w - 1)];
            let sub = row[x.saturating_sub(r)];
            acc += add - sub;
        }
        row.copy_from_slice(&tmp[..w]);
    }
    for x in 0..w {
        let mut acc: f32 = (0..=r.min(h - 1)).map(|i| buf[i * w + x]).sum::<f32>() + buf[x] * r as f32;
        for y in 0..h {
            tmp[y] = acc * norm;
            let add = buf[(y + r + 1).min(h - 1) * w + x];
            let sub = buf[y.saturating_sub(r) * w + x];
            acc += add - sub;
        }
        for y in 0..h {
            buf[y * w + x] = tmp[y];
        }
    }
}

struct Shadow {
    lw: usize,
    a: Vec<f32>,
    opacity: f32,
    /// Per final column: (low-res x0, x1, weight).
    xt: Vec<(u32, u32, f32)>,
    /// Per final row: (low-res y0, y1, weight).
    yt: Vec<(u32, u32, f32)>,
}

fn axis_table(n: usize, f: f32, max: usize) -> Vec<(u32, u32, f32)> {
    (0..n)
        .map(|i| {
            let fx = ((i as f32 + 0.5) / f - 0.5).max(0.0);
            let x0 = (fx as usize).min(max - 1);
            (x0 as u32, (x0 + 1).min(max - 1) as u32, fx - x0 as f32)
        })
        .collect()
}

impl Shadow {
    #[inline]
    fn at(&self, x: usize, y: usize) -> f32 {
        let (fx, fy) = (((x as f32 + 0.5) / self.f - 0.5).max(0.0), ((y as f32 + 0.5) / self.f - 0.5).max(0.0));
        let (x0, y0) = ((fx as usize).min(self.lw - 1), (fy as usize).min(self.lh - 1));
        let (x1, y1) = ((x0 + 1).min(self.lw - 1), (y0 + 1).min(self.lh - 1));
        let (tx, ty) = (fx - x0 as f32, fy - y0 as f32);
        let g = |xx: usize, yy: usize| self.a[yy * self.lw + xx];
        let top = g(x0, y0) + (g(x1, y0) - g(x0, y0)) * tx;
        let bot = g(x0, y1) + (g(x1, y1) - g(x0, y1)) * tx;
        (top + (bot - top) * ty) * self.opacity
    }
}

fn build_shadow(dev: &[u8], w: usize, h: usize, p: usize, fw: usize, fh: usize, layer: (f32, f32, f32), strength: f32) -> Shadow {
    let long = w.max(h) as f32;
    let f = ((fw.max(fh) as f32) / 400.0).max(1.0).floor();
    let (lw, lh) = ((fw as f32 / f).ceil() as usize + 1, (fh as f32 / f).ceil() as usize + 1);
    let mut a = vec![0f32; lw * lh];
    let st = ((f / 2.0) as usize).max(1);
    let oy = (layer.1 * long).round() as isize;
    let per_cell = ((f as usize).div_ceil(st) as f32).powi(2);
    for y in (0..h).step_by(st) {
        for x in (0..w).step_by(st) {
            let al = dev[(y * w + x) * 4 + 3];
            if al == 0 {
                continue;
            }
            let ly = (((y + p) as isize + oy).max(0) as f32 / f) as usize;
            let lx = ((x + p) as f32 / f) as usize;
            if ly < lh && lx < lw {
                a[ly * lw + lx] += al as f32 / 255.0 / per_cell;
            }
        }
    }
    let sigma = (layer.0 * long / f / 2.0).max(0.6);
    let r = sigma.round().max(1.0) as usize;
    for _ in 0..3 {
        box_blur(&mut a, lw, lh, r);
    }
    Shadow { lw, lh, f, a, opacity: (layer.2 * strength / 0.6).clamp(0.0, 0.9) }
}

#[inline]
fn hash01(x: u32, y: u32) -> f32 {
    let mut h = x.wrapping_mul(374_761_393).wrapping_add(y.wrapping_mul(668_265_263));
    h = (h ^ (h >> 13)).wrapping_mul(1_274_126_177);
    ((h ^ (h >> 16)) & 0xffff) as f32 / 65535.0
}

/// Composes `dev` (straight RGBA, `w x h`) onto the styled canvas. Returns (rgba, width, height).
pub fn compose(dev: &[u8], w: u32, h: u32, s: &Style) -> Result<(Vec<u8>, u32, u32), String> {
    if dev.len() != (w as usize) * (h as usize) * 4 {
        return Err("image buffer does not match its dimensions".into());
    }
    if s.is_identity() {
        return Ok((dev.to_vec(), w, h));
    }
    let (fw, fh, p) = final_layout(w, h, s);
    if (fw as u64) * (fh as u64) > crate::render::MAX_PIXELS {
        return Err(format!("output {fw}x{fh} exceeds the size limit"));
    }
    let (wu, hu, pu, fwu, fhu) = (w as usize, h as usize, p as usize, fw as usize, fh as usize);
    let shadows: Vec<Shadow> = layers(s.shadow).iter().map(|&l| build_shadow(dev, wu, hu, pu, fwu, fhu, l, s.strength)).collect();

    let (c0, c1, dir, len) = match &s.bg {
        Bg::Transparent => ([0.0; 3], [0.0; 3], (0.0, 0.0), 1.0),
        Bg::Solid { color } => {
            let c = parse_hex(color).unwrap();
            (c, c, (0.0, 0.0), 1.0)
        }
        Bg::Linear { from, to, angle } => {
            let a = angle.to_radians();
            let d = (a.sin(), -a.cos());
            (parse_hex(from).unwrap(), parse_hex(to).unwrap(), d, (fw as f32 * d.0).abs() + (fh as f32 * d.1).abs())
        }
    };
    let bg_alpha = if s.bg == Bg::Transparent { 0.0 } else { 1.0 };
    let (cx, cy) = (fw as f32 / 2.0, fh as f32 / 2.0);
    let mut out = vec![0u8; fwu * fhu * 4];
    for y in 0..fhu {
        for x in 0..fwu {
            // background (premultiplied)
            let t = (0.5 + ((x as f32 + 0.5 - cx) * dir.0 + (y as f32 + 0.5 - cy) * dir.1) / len).clamp(0.0, 1.0);
            let mut px = [0f32; 4];
            if bg_alpha > 0.0 {
                let n = (hash01(x as u32, y as u32) - 0.5) / 255.0; // dither against banding
                for i in 0..3 {
                    px[i] = (c0[i] + (c1[i] - c0[i]) * t + n).clamp(0.0, 1.0);
                }
                px[3] = 1.0;
            }
            for sh in &shadows {
                let a = sh.at(x, y);
                if a > 0.0015 {
                    let k = 1.0 - a;
                    px = [px[0] * k, px[1] * k, px[2] * k, a + px[3] * k]; // black shadow over background
                }
            }
            // device
            if x >= pu && y >= pu && x - pu < wu && y - pu < hu {
                let i = ((y - pu) * wu + (x - pu)) * 4;
                let a = dev[i + 3] as f32 / 255.0;
                if a > 0.0 {
                    let k = 1.0 - a;
                    for c in 0..3 {
                        px[c] = dev[i + c] as f32 / 255.0 * a + px[c] * k;
                    }
                    px[3] = a + px[3] * k;
                }
            }
            if px[3] > 0.0 {
                let o = (y * fwu + x) * 4;
                for c in 0..3 {
                    out[o + c] = ((px[c] / px[3]).clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
                }
                out[o + 3] = (px[3].clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
            }
        }
    }
    Ok((out, fw, fh))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn disc(w: u32, h: u32) -> Vec<u8> {
        // opaque red ellipse on a transparent canvas
        let mut v = vec![0u8; (w * h * 4) as usize];
        for y in 0..h {
            for x in 0..w {
                let (dx, dy) = ((x as f32 + 0.5) / w as f32 * 2.0 - 1.0, (y as f32 + 0.5) / h as f32 * 2.0 - 1.0);
                if dx * dx + dy * dy < 0.8 {
                    let i = ((y * w + x) * 4) as usize;
                    v[i..i + 4].copy_from_slice(&[200, 20, 20, 255]);
                }
            }
        }
        v
    }

    fn style(json: &str) -> Style {
        parse_style(json).unwrap()
    }

    #[test]
    fn default_style_is_identity() {
        let d = disc(60, 100);
        let (o, w, h) = compose(&d, 60, 100, &Style::default()).unwrap();
        assert_eq!((w, h), (60, 100));
        assert_eq!(o, d);
        assert_eq!(final_layout(60, 100, &Style::default()), (60, 100, 0));
    }

    #[test]
    fn solid_background_is_opaque_and_exact() {
        let d = disc(60, 100);
        let s = style(r##"{"bg":{"kind":"solid","color":"#102030"},"padding":0.1}"##);
        let (o, w, h) = compose(&d, 60, 100, &s).unwrap();
        assert_eq!((w, h), (80, 120));
        assert!(o.chunks(4).all(|p| p[3] == 255));
        assert_eq!(&o[..4], &[0x10, 0x20, 0x30, 255]);
        // device centre keeps its colour
        let c = ((60 * w + 40) * 4) as usize;
        assert_eq!(&o[c..c + 4], &[200, 20, 20, 255]);
    }

    #[test]
    fn gradient_goes_from_first_to_second_colour() {
        let d = disc(40, 40);
        let s = style(r##"{"bg":{"kind":"linear","from":"#000000","to":"#ffffff","angle":90},"padding":0.2}"##);
        let (o, w, h) = compose(&d, 40, 40, &s).unwrap();
        let at = |x: u32, y: u32| o[((y * w + x) * 4) as usize];
        assert!(at(0, 2) < 12, "left edge near the first colour");
        assert!(at(w - 1, 2) > 243, "right edge near the second colour");
        assert!(at(w / 2, 1) > 100 && at(w / 2, 1) < 156, "middle is mid-grey");
        let _ = h;
    }

    #[test]
    fn shadow_appears_outside_the_device_on_transparent_background() {
        let d = disc(80, 120);
        let s = style(r#"{"shadow":"soft","strength":0.8}"#);
        let (o, w, h) = compose(&d, 80, 120, &s).unwrap();
        let (_, _, p) = final_layout(80, 120, &s);
        assert!(p > 0 && w == 80 + 2 * p && h == 120 + 2 * p);
        // the device pixel at its centre is unchanged and opaque
        let c = (((p + 60) * w + p + 40) * 4) as usize;
        assert_eq!(&o[c..c + 4], &[200, 20, 20, 255]);
        // semi-transparent black shadow just below the ellipse (offset downward), nothing at the far corner
        let below = (((p + 117) * w + p + 40) * 4) as usize; // ~3 px under the ellipse bottom
        assert!(o[below + 3] > 10 && o[below + 3] < 255 && o[below] < 30, "shadow alpha {}", o[below + 3]);
        let above = ((1 * w + p + 40) * 4) as usize;
        assert!(o[below + 3] > o[above + 3], "offset pushes the shadow down");
        assert_eq!(o[3], 0, "canvas corner stays transparent");
    }

    #[test]
    fn stronger_shadows_are_darker() {
        let d = disc(80, 120);
        let alpha_below = |strength: f32| {
            let s = style(&format!(r#"{{"shadow":"floating","strength":{strength}}}"#));
            let (o, w, _) = compose(&d, 80, 120, &s).unwrap();
            let (_, _, p) = final_layout(80, 120, &s);
            o[(((p + 118) * w + p + 40) * 4 + 3) as usize]
        };
        assert!(alpha_below(0.9) > alpha_below(0.3));
    }

    #[test]
    fn final_size_is_linear_in_device_size() {
        let s = style(r#"{"padding":0.12,"shadow":"soft"}"#);
        let (a, _, _) = final_layout(1000, 2000, &s);
        let (b, _, _) = final_layout(500, 1000, &s);
        assert!((a as i64 - 2 * b as i64).abs() <= 2);
    }

    #[test]
    fn rejects_bad_styles() {
        assert!(parse_style(r#"{"padding":0.9}"#).is_err());
        assert!(parse_style(r#"{"bg":{"kind":"solid","color":"red"}}"#).is_err());
        assert!(parse_style("{not json").is_err());
        assert!(compose(&[0u8; 8], 5, 5, &style(r#"{"padding":0.1}"#)).is_err());
    }
}
