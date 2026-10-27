//! Typed, validated device manifest (`devices.json`, schema version 2).
//!
//! All physical sizes are millimetres. Screen active area and bezels are *derived* from the
//! published diagonal and pixel resolution rather than stored.

use serde::Deserialize;

pub const BUNDLED: &str = include_str!("../devices.json");
pub const KNOWN_ORIENTATIONS: [&str; 5] = ["portrait", "landscape", "right", "left", "front"];

#[derive(Debug, Clone, Deserialize)]
pub struct Manifest {
    pub version: u32,
    pub devices: Vec<Device>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Phone,
    Tablet,
    Laptop,
    Imac,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Device {
    pub id: String,
    pub brand: String,
    pub name: String,
    pub category: String,
    pub year: u32,
    pub kind: Kind,
    pub body: Body,
    pub screen: Screen,
    pub camera: Camera,
    pub finishes: Vec<Finish>,
    pub orientations: Vec<String>,
    #[serde(default)]
    pub laptop: Option<LaptopSpec>,
    #[serde(default)]
    pub stand: Option<StandSpec>,
    #[serde(default)]
    pub bezel_color: Option<String>,
    #[serde(default)]
    pub chin_colored: bool,
    /// Optional fine detail for the 3D views (ports, antenna bands, glass edge).
    #[serde(default)]
    pub details: Details,
    pub sources: Vec<Source>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Details {
    /// Bezel drawn as dark-grey cover glass with black hairlines instead of flat black.
    #[serde(default)]
    pub glass_edge: bool,
    /// Openings on the bottom wall, x measured from the centre (seen from the front, +x right).
    #[serde(default)]
    pub ports: Vec<Port>,
    #[serde(default)]
    pub bands: Bands,
    /// Draw the side buttons on the right wall instead of modelling them as boxes.
    #[serde(default)]
    pub wall_buttons: bool,
    /// Plan-view corner radius of the 3D model when it differs from the flat outline, mm.
    #[serde(default)]
    pub corner_r_3d: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PortKind {
    UsbC,
    Slot,
    Hole,
    Tray,
    Spen,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Port {
    pub kind: PortKind,
    pub x: f32,
    pub w: f32,
    pub h: f32,
}

/// Antenna split lines: x positions on the bottom/top walls, distance from the top on the long sides.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct Bands {
    #[serde(default)]
    pub bottom: Vec<f32>,
    #[serde(default)]
    pub top: Vec<f32>,
    #[serde(default)]
    pub side: Vec<f32>,
}

/// Outer body of the phone/tablet, or the lid / display slab for laptops and iMacs.
/// For laptops `h` is the lid height (= base depth) and `d` the closed total thickness.
#[derive(Debug, Clone, Deserialize)]
pub struct Body {
    pub w: f32,
    pub h: f32,
    pub d: f32,
    pub corner_r: f32,
    pub edge_r: f32,
    pub frame: f32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Screen {
    pub w: u32,
    pub h: u32,
    pub diag_in: f32,
    pub radius_mm: f32,
    /// Shifts the screen down (+) / up (-) from the body centre, in mm.
    #[serde(default)]
    pub dy: f32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Camera {
    None,
    Punch { y: f32, r: f32 },
    Island { y: f32, w: f32, h: f32 },
    Notch { w: f32, h: f32 },
    /// Webcam dot in the bezel, `y` mm above the screen's top edge.
    Dot { y: f32, r: f32 },
}

#[derive(Debug, Clone, Deserialize)]
pub struct LaptopSpec {
    pub lid_t: f32,
    pub open_deg: f32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct StandSpec {
    pub total_h: f32,
    pub foot_w: f32,
    pub foot_d: f32,
    pub foot_t: f32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Finish {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Source {
    pub field: String,
    /// `fetched`, `derived`, `estimated` or `generic`.
    pub status: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// Quantities derived from the published screen specs.
#[derive(Debug, Clone, Copy)]
pub struct Derived {
    pub active_w: f32,
    pub active_h: f32,
    /// Screen pixels per millimetre.
    pub ppm: f32,
    pub top_bezel: f32,
    pub bottom_bezel: f32,
    pub side_bezel: f32,
}

impl Device {
    /// Corner radius used by the 3D model.
    pub fn corner_r_3d(&self) -> f32 {
        self.details.corner_r_3d.unwrap_or(self.body.corner_r)
    }

    pub fn derived(&self) -> Derived {
        let (sw, sh) = (self.screen.w as f32, self.screen.h as f32);
        let diag_mm = self.screen.diag_in * 25.4;
        let hyp = sw.hypot(sh);
        let active_w = diag_mm * sw / hyp;
        let active_h = diag_mm * sh / hyp;
        let inset = self.body.edge_r + self.body.frame;
        let vfree = self.body.h / 2.0 - inset - active_h / 2.0;
        Derived {
            active_w,
            active_h,
            ppm: sw / active_w,
            top_bezel: vfree + self.screen.dy,
            bottom_bezel: vfree - self.screen.dy,
            side_bezel: self.body.w / 2.0 - inset - active_w / 2.0,
        }
    }
}

pub fn parse_hex(s: &str) -> Option<[f32; 3]> {
    let s = s.strip_prefix('#')?;
    if s.len() != 6 {
        return None;
    }
    let v = u32::from_str_radix(s, 16).ok()?;
    Some([(v >> 16 & 255) as f32 / 255.0, (v >> 8 & 255) as f32 / 255.0, (v & 255) as f32 / 255.0])
}

pub fn parse(json: &str) -> Result<Manifest, String> {
    let m: Manifest = serde_json::from_str(json).map_err(|e| format!("invalid manifest: {e}"))?;
    validate(&m)?;
    Ok(m)
}

pub fn validate(m: &Manifest) -> Result<(), String> {
    if m.version != 2 {
        return Err(format!("unsupported manifest version {}", m.version));
    }
    let mut seen = std::collections::HashSet::new();
    for d in &m.devices {
        let id = &d.id;
        if !seen.insert(id) {
            return Err(format!("duplicate device id '{id}'"));
        }
        if d.screen.w == 0 || d.screen.h == 0 || d.screen.diag_in <= 0.0 {
            return Err(format!("{id}: invalid screen"));
        }
        if d.finishes.is_empty() {
            return Err(format!("{id}: no finishes"));
        }
        for c in d.finishes.iter().map(|f| &f.color).chain(d.bezel_color.iter()) {
            parse_hex(c).ok_or_else(|| format!("{id}: bad color '{c}'"))?;
        }
        if d.orientations.is_empty() || d.orientations.iter().any(|o| !KNOWN_ORIENTATIONS.contains(&o.as_str())) {
            return Err(format!("{id}: bad orientation list"));
        }
        let landscape_ok = matches!(d.kind, Kind::Phone | Kind::Tablet);
        if d.orientations.iter().any(|o| o == "front") == landscape_ok {
            return Err(format!("{id}: 'front' is for laptops/iMacs, 'portrait' for phones/tablets"));
        }
        let b = &d.body;
        if b.w <= 0.0 || b.h <= 0.0 || b.d <= 0.0 || b.edge_r < 0.0 || b.frame < 0.0 || b.corner_r <= b.edge_r + 0.2 {
            return Err(format!("{id}: invalid body"));
        }
        if b.d < 2.0 * b.edge_r {
            return Err(format!("{id}: body thinner than its edge fillets"));
        }
        let v = d.derived();
        if v.side_bezel < 0.05 || v.top_bezel < 0.05 || v.bottom_bezel < 0.05 {
            return Err(format!("{id}: screen does not fit the body (bezels {:.2}/{:.2}/{:.2} mm)", v.top_bezel, v.bottom_bezel, v.side_bezel));
        }
        match d.kind {
            Kind::Laptop if d.laptop.is_none() => return Err(format!("{id}: laptop needs 'laptop' spec")),
            Kind::Imac if d.stand.is_none() => return Err(format!("{id}: iMac needs 'stand' spec")),
            _ => {}
        }
        if let Some(l) = &d.laptop {
            if l.lid_t <= 0.0 || l.lid_t >= b.d || !(60.0..=150.0).contains(&l.open_deg) {
                return Err(format!("{id}: invalid laptop spec"));
            }
        }
        if let Some(s) = &d.stand {
            if s.total_h <= b.h || s.foot_w <= 0.0 || s.foot_d <= 0.0 || s.foot_t <= 0.0 {
                return Err(format!("{id}: invalid stand spec"));
            }
        }
        if d.details.corner_r_3d.is_some_and(|r| !(r > b.edge_r + 0.2 && r < b.w / 4.0)) {
            return Err(format!("{id}: invalid corner_r_3d"));
        }
        for p in &d.details.ports {
            if !(p.w > 0.0 && p.h > 0.0 && p.h < b.d && p.x.abs() + p.w / 2.0 < b.w / 2.0 - b.edge_r) {
                return Err(format!("{id}: port {:?} does not fit the bottom wall", p.kind));
            }
        }
        let bd = &d.details.bands;
        if bd.bottom.iter().chain(&bd.top).any(|x| x.abs() >= b.w / 2.0) || bd.side.iter().any(|y| !(0.0..b.h).contains(y)) {
            return Err(format!("{id}: antenna band outside the body"));
        }
        if d.sources.is_empty() {
            return Err(format!("{id}: missing source records"));
        }
        for s in &d.sources {
            if !["fetched", "derived", "estimated", "generic"].contains(&s.status.as_str()) {
                return Err(format!("{id}: bad source status '{}'", s.status));
            }
            if s.status == "fetched" && s.url.is_none() {
                return Err(format!("{id}: fetched value '{}' needs a url", s.field));
            }
        }
    }
    Ok(())
}

pub fn bundled() -> Manifest {
    parse(BUNDLED).expect("bundled devices.json must be valid")
}

pub fn find<'a>(m: &'a Manifest, id: &str) -> Option<&'a Device> {
    m.devices.iter().find(|d| d.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_is_valid() {
        let m = bundled();
        assert!(find(&m, "galaxy-s24-ultra").is_some());
        assert!(find(&m, "imac-24").is_some());
    }

    #[test]
    fn derives_active_area_from_diagonal() {
        let m = bundled();
        let d = find(&m, "galaxy-s24-ultra").unwrap().derived();
        // 6.8" 1440x3120: width ~72.2 mm, 19.9 px/mm, side bezels about 3.4mm minus rim and fillet
        assert!((d.active_w - 72.2).abs() < 0.3, "{}", d.active_w);
        assert!((d.ppm - 19.9).abs() < 0.2);
        assert!(d.side_bezel > 1.0 && d.side_bezel < 3.0);
    }

    #[test]
    fn rejects_duplicates_and_bad_colors() {
        let mut m = bundled();
        m.devices.push(m.devices[0].clone());
        assert!(validate(&m).unwrap_err().contains("duplicate"));
        let mut m = bundled();
        m.devices[0].finishes[0].color = "red".into();
        assert!(validate(&m).is_err());
    }

    #[test]
    fn rejects_oversized_screen_and_bad_orientations() {
        let mut m = bundled();
        m.devices[0].screen.diag_in = 9.0;
        assert!(validate(&m).unwrap_err().contains("does not fit"));
        let mut m = bundled();
        m.devices[0].orientations = vec!["front".into()];
        assert!(validate(&m).is_err());
        let mut m = bundled();
        m.devices[0].sources.clear();
        assert!(validate(&m).is_err());
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse("{\"version\":2,").is_err());
        assert!(parse("{\"version\":1,\"devices\":[]}").is_err());
    }
}
