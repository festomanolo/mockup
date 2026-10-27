//! Side-wall shader for phones and tablets in the tilted 3D views: studio-lit metal frame with a
//! top lip and groove, antenna split bands, bottom-wall openings (USB-C, speaker, mic, SIM tray,
//! S Pen) and side buttons. Works in model space (mm): x right, y up, front face at z = 0.

use crate::front::{cover, sd_rrect};
use crate::manifest::{Device, Port, PortKind};
use crate::mesh::V3;

pub struct Wall {
    hh: f32,
    d: f32,
    base: [f32; 3],
    ports: Vec<Port>,
    bands_bottom: Vec<f32>,
    bands_top: Vec<f32>,
    bands_side: Vec<f32>,
    /// Side buttons drawn on the right wall: (centre from the top, half length) in mm.
    buttons: Vec<(f32, f32)>,
}

const LIP: f32 = 0.3;
const GROOVE: f32 = 0.75;

fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [0, 1, 2].map(|i| a[i] + (b[i] - a[i]) * t)
}

fn smooth(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

impl Wall {
    pub fn new(d: &Device, base: [f32; 3]) -> Self {
        let b = &d.body;
        let det = &d.details;
        let buttons = if det.wall_buttons { BUTTONS.iter().map(|&(t, h)| (t * b.h, h * b.h)).collect() } else { Vec::new() };
        Self {
            hh: b.h / 2.0,
            d: b.d,
            base,
            ports: det.ports.clone(),
            bands_bottom: det.bands.bottom.clone(),
            bands_top: det.bands.top.clone(),
            bands_side: det.bands.side.clone(),
            buttons,
        }
    }

    /// Brightness of the bare frame at depth `zm` (mm below the front face) on a wall whose
    /// normal is mostly along x (`wx` = 1) or y (`wx` = 0).
    fn profile(&self, zm: f32, wx: f32, fp: f32) -> f32 {
        let t = ((zm - GROOVE) / (self.d - GROOVE)).clamp(0.0, 1.0);
        let wall_y = 0.88 - 0.12 * t;
        let wall_x = if t < 0.3 { 0.68 + 0.16 * smooth(0.0, 0.3, t) } else { 0.84 - 0.11 * (t - 0.3) / 0.7 };
        let wall = wall_y + (wall_x - wall_y) * wx;
        // polished lip on top, a dark chamfer just below it, a darker back fillet
        let groove = cover(LIP - zm, fp) * cover(zm - GROOVE, fp);
        let lip = cover(zm - LIP, fp);
        let back = smooth(self.d - LIP, self.d, zm);
        let mut l = wall + (0.68 - wall) * groove + (0.92 - wall) * lip;
        l -= 0.12 * back;
        l
    }

    /// `p` model position, `n` model normal, `fp` approximate pixel footprint in mm.
    pub fn shade(&self, p: V3, n: V3, fp: f32) -> [f32; 3] {
        let zm = (-p[2]).clamp(0.0, self.d);
        let (ax, ay) = (n[0].abs(), n[1].abs());
        let wx = ax / (ax + ay + 1e-6);
        let mut c = self.base.map(|v| v * self.profile(zm, wx, fp));
        let on_wall = cover(LIP + 0.05 - zm, fp) * cover(zm - (self.d - LIP), fp);
        if on_wall <= 0.0 {
            return c;
        }
        let zc = self.d / 2.0 - zm; // 0 at mid-thickness, + toward the front
        // antenna split bands across the wall
        let band = |c: [f32; 3], off: f32| -> [f32; 3] {
            let d = off.abs() - 0.45;
            let inside = cover(d, fp) * on_wall;
            if inside <= 0.0 && d > 0.2 {
                return c;
            }
            let lum = (c[0] + c[1] + c[2]) / 3.0;
            let strip = mix(c, [(lum * 1.12).min(1.0); 3], 0.8);
            let c = mix(c, strip, inside);
            let edge = cover(d.abs() - 0.07, fp) * on_wall;
            mix(c, c.map(|v| v * 0.84), edge)
        };
        if ay > 0.6 {
            let bands = if n[1] < 0.0 { &self.bands_bottom } else { &self.bands_top };
            for &bx in bands {
                c = band(c, p[0] - bx);
            }
        }
        if ax > 0.6 {
            let s = self.hh - p[1];
            for &by in &self.bands_side {
                c = band(c, s - by);
            }
        }
        if n[1] < -0.6 && p[1] < -self.hh + 1.0 {
            for port in &self.ports {
                c = self.port(c, port, p[0], zc, fp, on_wall);
            }
        }
        if n[0] > 0.6 {
            let s = self.hh - p[1];
            for &(cy, half) in &self.buttons {
                let dd = sd_rrect(s, zc, cy, 0.0, half, 1.05, 1.05);
                if dd > 0.3 {
                    continue;
                }
                let inside = cover(dd, fp);
                c = mix(c, c.map(|v| (v * 1.05).min(1.0)), inside);
                // highlight along the front-facing edge, shadow line around the outline
                let hl = cover(dd + 0.25, fp) * (1.0 - cover(dd + 0.1, fp)) * smooth(-0.2, 0.6, zc);
                c = mix(c, c.map(|v| (v * 1.18).min(1.0)), hl);
                c = mix(c, c.map(|v| v * 0.66), cover(dd.abs() - 0.07, fp));
            }
        }
        c
    }

    fn port(&self, c: [f32; 3], port: &Port, x: f32, zc: f32, fp: f32, on_wall: f32) -> [f32; 3] {
        let (hw, hh) = (port.w / 2.0, port.h / 2.0);
        let r = match port.kind {
            PortKind::Spen => hh.min(1.9),
            _ => hh,
        };
        let dd = sd_rrect(x, zc, port.x, 0.0, hw, hh, r);
        if dd > 0.3 {
            return c;
        }
        let a = cover(dd, fp) * on_wall;
        match port.kind {
            PortKind::Slot | PortKind::Hole => mix(c, [0.04, 0.04, 0.045], a),
            PortKind::Tray => {
                let line = cover(dd.abs() - 0.06, fp) * on_wall;
                mix(c, c.map(|v| v * 0.6), line)
            }
            PortKind::UsbC => {
                // polished chamfer ring, dark opening with the connector tongue
                let ring = mix(c, [0.80, 0.80, 0.81], a);
                let hole = cover(dd + 0.42, fp) * on_wall;
                let inner = mix([0.26, 0.26, 0.27], [0.38, 0.38, 0.39], smooth(-hh, hh, zc));
                let mut o = mix(ring, inner, hole);
                let tongue = cover(sd_rrect(x, zc, port.x, 0.0, hw - 1.4, 0.4, 0.35), fp) * hole;
                o = mix(o, [0.12, 0.12, 0.13], tongue);
                mix(o, c.map(|v| v * 0.55), cover(dd.abs() - 0.05, fp) * on_wall)
            }
            PortKind::Spen => {
                // dark plastic cap with a soft bevel catching light on the front side
                let cap = mix([0.21, 0.21, 0.22], [0.30, 0.30, 0.31], smooth(-hh, hh, zc));
                let mut o = mix(c, cap, a);
                let bevel = cover(dd + 0.35, fp);
                o = mix(o, o.map(|v| v * 1.35 + 0.04), (1.0 - bevel) * a * smooth(-0.5, 1.0, zc));
                mix(o, c.map(|v| v * 0.45), cover(dd.abs() - 0.06, fp) * on_wall)
            }
        }
    }
}

/// Side buttons as fractions of body height: (centre from the top, half length).
pub const BUTTONS: [(f32, f32); 2] = [(0.25, 0.065), (0.41, 0.033)];
