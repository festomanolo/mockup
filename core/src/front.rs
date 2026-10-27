//! 2D shader for a device's front face (frame, bezel, screen, camera cutout, screenshot).
//!
//! Works in "face pixels": the screen is exactly `screen.w x screen.h` px, origin at the body
//! centre, +y down. Both the flat renderer and the 3D rasterizer sample it.

use crate::manifest::{parse_hex, Camera, Device};
use std::borrow::Cow;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fit {
    Cover,
    Contain,
    Stretch,
}

impl Fit {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "cover" => Self::Cover,
            "contain" => Self::Contain,
            "stretch" => Self::Stretch,
            _ => return None,
        })
    }
}

pub struct Image<'a> {
    pub rgba: &'a [u8],
    pub w: u32,
    pub h: u32,
}

#[inline]
pub fn sd_rrect(px: f32, py: f32, cx: f32, cy: f32, hw: f32, hh: f32, r: f32) -> f32 {
    let r = r.min(hw).min(hh).max(0.0);
    let qx = (px - cx).abs() - hw + r;
    let qy = (py - cy).abs() - hh + r;
    qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - r
}

#[inline]
pub fn cover(d: f32, fp: f32) -> f32 {
    (0.5 - d / fp).clamp(0.0, 1.0)
}

/// Premultiplied RGBA "over".
#[inline]
pub fn over(dst: &mut [f32; 4], rgb: [f32; 3], a: f32) {
    if a <= 0.0 {
        return;
    }
    let k = 1.0 - a;
    for i in 0..3 {
        dst[i] = rgb[i] * a + dst[i] * k;
    }
    dst[3] = a + dst[3] * k;
}

/// Screenshot resampling data: screen-local px -> screenshot px.
pub struct Shot {
    /// RGB, alpha already flattened onto white.
    data: Vec<u8>,
    w: u32,
    h: u32,
    sx: f32,
    sy: f32,
    fw: f32,
    fh: f32,
}

/// Box-filter down by an integer factor so heavy downscales stay clean.
fn prefilter(img: &Image, f: u32) -> (Vec<u8>, u32, u32) {
    let (nw, nh) = ((img.w / f).max(1), (img.h / f).max(1));
    let mut out = vec![0u8; (nw * nh * 4) as usize];
    for y in 0..nh {
        for x in 0..nw {
            let mut acc = [0u32; 4];
            let mut n = 0;
            for dy in 0..f {
                for dx in 0..f {
                    let (sx, sy) = ((x * f + dx).min(img.w - 1), (y * f + dy).min(img.h - 1));
                    let i = ((sy * img.w + sx) * 4) as usize;
                    let a = img.rgba[i + 3] as u32; // alpha-weighted so transparent pixels don't darken edges
                    acc[0] += img.rgba[i] as u32 * a;
                    acc[1] += img.rgba[i + 1] as u32 * a;
                    acc[2] += img.rgba[i + 2] as u32 * a;
                    acc[3] += a;
                    n += 1;
                }
            }
            let o = ((y * nw + x) * 4) as usize;
            if acc[3] > 0 {
                for c in 0..3 {
                    out[o + c] = (acc[c] / acc[3]) as u8;
                }
            }
            out[o + 3] = (acc[3] / n) as u8;
        }
    }
    (out, nw, nh)
}

pub fn prepare_shot(img: &Image, fit: Fit, sw: f32, sh: f32, target_w: f32) -> Result<Shot, String> {
    if img.w == 0 || img.h == 0 || img.rgba.len() != (img.w as usize) * (img.h as usize) * 4 {
        return Err("screenshot buffer does not match its dimensions".into());
    }
    let f = ((img.w as f32 / target_w.max(1.0) / 1.5) as u32).clamp(1, 16);
    let (src, w, h): (Cow<[u8]>, u32, u32) = if f > 1 {
        let (v, w, h) = prefilter(img, f);
        (Cow::Owned(v), w, h)
    } else {
        (Cow::Borrowed(img.rgba), img.w, img.h)
    };
    let mut data = Vec::with_capacity(src.len() / 4 * 3);
    for p in src.chunks_exact(4) {
        let a = p[3] as u32;
        for c in &p[..3] {
            data.push(((*c as u32 * a + 255 * (255 - a) + 127) / 255) as u8); // transparent reads as white
        }
    }
    let (fw, fh) = (img.w as f32, img.h as f32);
    let (sx, sy) = match fit {
        Fit::Stretch => (sw / fw, sh / fh),
        Fit::Cover => {
            let s = (sw / fw).max(sh / fh);
            (s, s)
        }
        Fit::Contain => {
            let s = (sw / fw).min(sh / fh);
            (s, s)
        }
    };
    Ok(Shot { data, w, h, sx, sy, fw, fh })
}

#[inline]
fn bilinear(data: &[u8], w: u32, h: u32, x: f32, y: f32) -> [f32; 3] {
    let (x, y) = ((x - 0.5).clamp(0.0, (w - 1) as f32), (y - 0.5).clamp(0.0, (h - 1) as f32));
    let (x0, y0) = (x as u32, y as u32);
    let (x1, y1) = ((x0 + 1).min(w - 1), (y0 + 1).min(h - 1));
    let (fx, fy) = (x - x0 as f32, y - y0 as f32);
    let i00 = ((y0 * w + x0) * 3) as usize;
    let i10 = ((y0 * w + x1) * 3) as usize;
    let i01 = ((y1 * w + x0) * 3) as usize;
    let i11 = ((y1 * w + x1) * 3) as usize;
    let k = 1.0 / 255.0;
    [0, 1, 2].map(|c| {
        let top = data[i00 + c] as f32 + (data[i10 + c] as f32 - data[i00 + c] as f32) * fx;
        let bot = data[i01 + c] as f32 + (data[i11 + c] as f32 - data[i01 + c] as f32) * fx;
        (top + (bot - top) * fy) * k
    })
}

#[derive(Clone, Copy)]
enum Cam {
    None,
    Punch { cy: f32, r: f32 },
    Island { cy: f32, hw: f32, hh: f32 },
    Notch { hw: f32, h: f32 },
    Dot { cy: f32, r: f32 },
}

pub struct FrontSpec {
    body_hw: f32,
    body_hh: f32,
    body_r: f32,
    frame_rgb: [f32; 3],
    bezel_hw: f32,
    bezel_hh: f32,
    bezel_r: f32,
    bezel_rgb: [f32; 3],
    /// Bezel colour stops here (y-down); below it the body colour shows (iMac chin).
    chin_y: Option<f32>,
    scr_cy: f32,
    scr_hw: f32,
    scr_hh: f32,
    scr_r: f32,
    cam: Cam,
    /// Add a rim highlight to the frame (flat renderer, where the body includes the fillet).
    rim: bool,
    shot: Option<Shot>,
    safe_hw: f32,
    safe_hh: f32,
    cam_box: [f32; 4],
    /// Cover-glass bezel: dark grey with black hairlines (see `Details::glass_edge`); face px per mm.
    glass: Option<f32>,
}

impl FrontSpec {
    /// `flat`: the body spans the full outline (fillet included). Otherwise the face ends where
    /// the 3D fillet begins and is slightly oversized so it is always fully opaque.
    pub fn new(d: &Device, finish: usize, flat: bool, shot: Option<Shot>) -> Result<Self, String> {
        let v = d.derived();
        let ppm = v.ppm;
        let b = &d.body;
        let frame_rgb = parse_hex(&d.finishes.get(finish).ok_or("finish index out of range")?.color).ok_or("bad finish color")?;
        let bezel_rgb = match &d.bezel_color {
            Some(c) => parse_hex(c).ok_or("bad bezel color")?,
            None => [0.02, 0.02, 0.025],
        };
        let (sw, sh) = (d.screen.w as f32, d.screen.h as f32);
        let face_inset = if flat { 0.0 } else { b.edge_r };
        let slack = if flat { 0.0 } else { 1.5 };
        let body_hw = (b.w / 2.0 - face_inset) * ppm + slack;
        let body_hh = (b.h / 2.0 - face_inset) * ppm + slack;
        let body_r = ((if flat { b.corner_r } else { d.corner_r_3d() } - face_inset) * ppm).max(1.0);
        // seen in 3D, a glass-edged phone shows only a thin metal lip; the rest of the frame
        // width sits under the cover glass
        let frame_w = if d.details.glass_edge && !flat { 0.35 * ppm } else { (b.frame + if flat { b.edge_r } else { 0.0 }) * ppm };
        let scr_cy = d.screen.dy * ppm;
        let (bezel_hw, bezel_hh) = (body_hw - slack - frame_w, body_hh - slack - frame_w);
        let chin_y = d.chin_colored.then(|| scr_cy + sh / 2.0 + v.side_bezel.min(v.top_bezel) * ppm);
        let cam = match d.camera {
            Camera::None => Cam::None,
            Camera::Punch { y, r } => Cam::Punch { cy: scr_cy - sh / 2.0 + y * ppm, r: r * ppm },
            Camera::Island { y, w, h } => Cam::Island { cy: scr_cy - sh / 2.0 + (y + h / 2.0) * ppm, hw: w * ppm / 2.0, hh: h * ppm / 2.0 },
            Camera::Notch { w, h } => Cam::Notch { hw: w * ppm / 2.0, h: h * ppm },
            Camera::Dot { y, r } => Cam::Dot { cy: scr_cy - sh / 2.0 - y * ppm, r: r * ppm },
        };
        let scr_r = d.screen.radius_mm * ppm;
        let top = scr_cy - sh / 2.0;
        let cam_box = match cam {
            Cam::None => [f32::MAX; 4],
            Cam::Punch { cy, r } | Cam::Dot { cy, r } => [-r, cy - r, r, cy + r],
            Cam::Island { cy, hw, hh } => [-hw, cy - hh, hw, cy + hh],
            Cam::Notch { hw, h } => [-hw, top - 1.0, hw, top + h],
        };
        Ok(Self {
            safe_hw: sw / 2.0 - scr_r,
            safe_hh: sh / 2.0 - scr_r,
            cam_box,
            body_hw,
            body_hh,
            body_r,
            frame_rgb,
            bezel_hw,
            bezel_hh,
            bezel_r: (body_r - frame_w).max(1.0),
            bezel_rgb,
            chin_y,
            scr_cy,
            scr_hw: sw / 2.0,
            scr_hh: sh / 2.0,
            scr_r,
            cam,
            rim: flat,
            shot,
            glass: d.details.glass_edge.then_some(ppm),
        })
    }

    pub fn body_half(&self) -> (f32, f32) {
        (self.body_hw, self.body_hh)
    }

    /// Premultiplied RGBA at face pixel (x, y); `fp` is the pixel footprint in face pixels.
    /// `edge_aa` anti-aliases the body outline (flat renderer); the 3D path supplies its own edges.
    #[inline]
    fn screen_rgb(&self, x: f32, y: f32) -> [f32; 3] {
        match &self.shot {
            Some(s) => {
                let ix = x / s.sx + s.fw / 2.0;
                let iy = (y - self.scr_cy) / s.sy + s.fh / 2.0;
                if ix < -0.5 || iy < -0.5 || ix > s.fw + 0.5 || iy > s.fh + 0.5 {
                    [0.0, 0.0, 0.0]
                } else {
                    bilinear(&s.data, s.w, s.h, ix * (s.w as f32 / s.fw), iy * (s.h as f32 / s.fh))
                }
            }
            None => [1.0, 1.0, 1.0],
        }
    }

    pub fn shade(&self, x: f32, y: f32, fp: f32, edge_aa: bool) -> [f32; 4] {
        let fp = fp.clamp(1e-3, 64.0);
        // Fast path: well inside the flat part of the screen and clear of the camera cutout.
        if x.abs() < self.safe_hw - fp
            && (y - self.scr_cy).abs() < self.safe_hh - fp
            && (x < self.cam_box[0] - fp || x > self.cam_box[2] + fp || y < self.cam_box[1] - fp || y > self.cam_box[3] + fp)
        {
            let c = self.screen_rgb(x, y);
            return [c[0], c[1], c[2], 1.0];
        }
        let mut px = [0f32; 4];
        let ds = sd_rrect(x, y, 0.0, self.scr_cy, self.scr_hw, self.scr_hh, self.scr_r);
        let (cam_d, cam_ring_r) = match self.cam {
            Cam::None => (f32::MAX, 0.0),
            Cam::Punch { cy, r } => ((x.hypot(y - cy)) - r, r),
            Cam::Island { cy, hw, hh } => (sd_rrect(x, y, 0.0, cy, hw, hh, hh), 0.0),
            Cam::Notch { hw, h } => {
                // hangs from the top screen edge; only the lower corners are rounded
                let top = self.scr_cy - self.scr_hh;
                (sd_rrect(x, y, 0.0, top, hw, h, h * 0.35).max(top - y), 0.0)
            }
            Cam::Dot { cy, r } => (x.hypot(y - cy) - r, r),
        };
        let in_screen_deep = ds < -fp && !matches!(self.cam, Cam::Dot { .. }) && cam_d > fp;
        if !in_screen_deep {
            let dd = sd_rrect(x, y, 0.0, 0.0, self.body_hw, self.body_hh, self.body_r);
            let a = if edge_aa { cover(dd, fp) } else { 1.0 };
            if a > 0.0 {
                let mut mul = 0.96;
                if self.rim && dd > -3.0 {
                    mul += 0.22;
                }
                over(&mut px, self.frame_rgb.map(|c| (c * mul).min(1.0)), a);
                let mut db = sd_rrect(x, y, 0.0, 0.0, self.bezel_hw, self.bezel_hh, self.bezel_r);
                if let Some(cy) = self.chin_y {
                    db = db.max(y - cy);
                }
                over(&mut px, self.bezel_rgb, cover(db, fp) * a);
            }
        }
        let sa = cover(ds, fp);
        if sa > 0.0 {
            let rgb = self.screen_rgb(x, y);
            over(&mut px, rgb, sa);
        }
        match self.cam {
            Cam::None => {}
            Cam::Punch { .. } | Cam::Dot { .. } => {
                let r = cam_ring_r;
                let a = cover(cam_d, fp) * if matches!(self.cam, Cam::Dot { .. }) { 1.0 } else { sa };
                if matches!(self.cam, Cam::Dot { .. }) {
                    // small lens inside the bezel
                    over(&mut px, [0.08, 0.09, 0.12], a);
                } else {
                    over(&mut px, [0.0, 0.0, 0.0], a);
                    // dark rim around a blue-black lens
                    over(&mut px, [0.2, 0.21, 0.24], cover(cam_d + r * 0.18, fp) * (1.0 - cover(cam_d + r * 0.42, fp)) * sa);
                    over(&mut px, [0.1, 0.13, 0.2], cover(cam_d + r * 0.62, fp) * sa);
                }
            }
            Cam::Island { .. } | Cam::Notch { .. } => over(&mut px, [0.0, 0.0, 0.0], cover(cam_d, fp) * sa),
        }
        px
    }
}
