//! mockup-core: device manifest + software renderer. Compiled natively for tests
//! and to WebAssembly (feature `wasm`) for the browser.

pub mod compose;
pub mod front;
pub mod geometry;
pub mod manifest;
pub mod mesh;
pub mod raster;
pub mod render;

#[cfg(feature = "wasm")]
mod wasm {
    use crate::{manifest, render};
    use wasm_bindgen::prelude::*;

    #[wasm_bindgen]
    pub fn manifest_json() -> String {
        manifest::BUNDLED.to_string()
    }

    #[wasm_bindgen]
    pub struct Rendered {
        width: u32,
        height: u32,
        data: Vec<u8>,
    }

    #[wasm_bindgen]
    impl Rendered {
        #[wasm_bindgen(getter)]
        pub fn width(&self) -> u32 {
            self.width
        }
        #[wasm_bindgen(getter)]
        pub fn height(&self) -> u32 {
            self.height
        }
        /// Straight (non-premultiplied) RGBA bytes.
        pub fn take_data(&mut self) -> Vec<u8> {
            std::mem::take(&mut self.data)
        }
    }

    fn lookup(device_id: &str, orientation: &str) -> Result<(manifest::Device, render::Orientation), JsError> {
        let m = manifest::bundled();
        let d = manifest::find(&m, device_id).ok_or_else(|| JsError::new("unknown device"))?.clone();
        let o = render::Orientation::parse(orientation).ok_or_else(|| JsError::new("bad orientation"))?;
        Ok((d, o))
    }

    /// Output size in pixels at `scale` (1.0 = screen at native resolution): `[width, height]`.
    #[wasm_bindgen]
    pub fn output_size(device_id: &str, orientation: &str, scale: f32) -> Result<Vec<u32>, JsError> {
        let (d, o) = lookup(device_id, orientation)?;
        let (w, h) = render::output_size(&d, o, scale).map_err(|e| JsError::new(&e))?;
        Ok(vec![w, h])
    }

    /// Final size after background/padding/shadow for a device image of `w x h`: `[width, height]`.
    #[wasm_bindgen]
    pub fn final_size(w: u32, h: u32, style_json: &str) -> Result<Vec<u32>, JsError> {
        let st = crate::compose::parse_style(style_json).map_err(|e| JsError::new(&e))?;
        let (fw, fh, _) = crate::compose::final_layout(w, h, &st);
        Ok(vec![fw, fh])
    }

    /// Composes a rendered device (straight RGBA) onto a background with padding and shadows.
    #[wasm_bindgen]
    pub fn compose(rgba: &[u8], w: u32, h: u32, style_json: &str) -> Result<Rendered, JsError> {
        let st = crate::compose::parse_style(style_json).map_err(|e| JsError::new(&e))?;
        let (data, fw, fh) = crate::compose::compose(rgba, w, h, &st).map_err(|e| JsError::new(&e))?;
        Ok(Rendered { width: fw, height: fh, data })
    }

    /// `rgba` may be empty to render the blank white screen.
    #[wasm_bindgen]
    pub fn render(
        device_id: &str,
        finish: usize,
        orientation: &str,
        fit: &str,
        scale: f32,
        rgba: &[u8],
        w: u32,
        h: u32,
    ) -> Result<Rendered, JsError> {
        let (d, o) = lookup(device_id, orientation)?;
        let params = render::Params {
            finish,
            orientation: o,
            fit: render::Fit::parse(fit).ok_or_else(|| JsError::new("bad fit"))?,
            scale,
            screenshot: if rgba.is_empty() { None } else { Some(render::Image { rgba, w, h }) },
        };
        let out = render::render(&d, &params).map_err(|e| JsError::new(&e))?;
        Ok(Rendered { width: out.width, height: out.height, data: out.data })
    }
}

#[cfg(test)]
mod tests {
    use crate::manifest::{bundled, find, Device};
    use crate::render::*;

    fn dev(id: &str) -> Device {
        find(&bundled(), id).unwrap().clone()
    }

    fn solid(w: u32, h: u32, c: [u8; 4]) -> Vec<u8> {
        c.iter().copied().cycle().take((w * h * 4) as usize).collect()
    }

    fn params(o: Orientation, img: Option<Image>, scale: f32) -> Params {
        Params { finish: 0, orientation: o, fit: Fit::Cover, scale, screenshot: img }
    }

    fn px(o: &Output, x: u32, y: u32) -> [u8; 4] {
        let i = ((y * o.width + x) * 4) as usize;
        [o.data[i], o.data[i + 1], o.data[i + 2], o.data[i + 3]]
    }

    #[test]
    fn output_dimensions_follow_real_size() {
        let d = dev("galaxy-s24-ultra");
        let (pw, ph) = output_size(&d, Orientation::Portrait, 1.0).unwrap();
        let (lw, lh) = output_size(&d, Orientation::Landscape, 1.0).unwrap();
        assert_eq!((pw, ph), (lh, lw));
        // screen at native resolution: 1440 px wide plus bezels/frame
        assert!(pw > 1440 && pw < 1700, "{pw}");
        let o = render(&d, &params(Orientation::Portrait, None, 0.25)).unwrap();
        assert_eq!((o.width, o.height), output_size(&d, Orientation::Portrait, 0.25).unwrap());
        assert_eq!(o.data.len(), (o.width * o.height * 4) as usize);
    }

    #[test]
    fn screen_shows_screenshot_and_corners_stay_transparent() {
        let d = dev("galaxy-s24-ultra");
        let img = solid(40, 80, [255, 0, 0, 255]);
        let o = render(&d, &params(Orientation::Portrait, Some(Image { rgba: &img, w: 40, h: 80 }), 0.25)).unwrap();
        assert_eq!(px(&o, 0, 0)[3], 0);
        assert_eq!(px(&o, o.width / 2, o.height / 2), [255, 0, 0, 255]);
    }

    #[test]
    fn contain_letterboxes_instead_of_stretching() {
        let d = dev("galaxy-s24-ultra");
        let img = solid(300, 100, [255, 255, 255, 255]);
        let mut p = params(Orientation::Portrait, Some(Image { rgba: &img, w: 300, h: 100 }), 0.25);
        p.fit = Fit::Contain;
        let o = render(&d, &p).unwrap();
        assert_eq!(px(&o, o.width / 2, o.height / 2)[0], 255);
        assert_eq!(px(&o, o.width / 2, o.height / 2 - o.height / 5)[0], 0);
    }

    #[test]
    fn rejects_bad_inputs() {
        let d = dev("galaxy-s24-ultra");
        let bad = vec![0u8; 10];
        assert!(render(&d, &params(Orientation::Portrait, Some(Image { rgba: &bad, w: 40, h: 80 }), 0.25)).is_err());
        assert!(render(&d, &params(Orientation::Portrait, None, 50.0)).is_err(), "oversized output");
        assert!(render(&d, &params(Orientation::Portrait, None, f32::NAN)).is_err());
        assert!(render(&d, &params(Orientation::Front, None, 0.2)).is_err(), "phones have no front view");
        let mut p = params(Orientation::Portrait, None, 0.2);
        p.finish = 99;
        assert!(render(&d, &p).is_err());
    }

    #[test]
    fn angled_phone_shows_side_wall_outside_the_screen() {
        let d = dev("galaxy-s24-ultra");
        let img = solid(40, 80, [255, 0, 0, 255]);
        let o = render(&d, &params(Orientation::Right, Some(Image { rgba: &img, w: 40, h: 80 }), 0.2)).unwrap();
        let red = o.data.chunks(4).filter(|p| p[3] == 255 && p[0] > 240 && p[1] < 20).count();
        let metal = o.data.chunks(4).filter(|p| p[3] > 200 && p[0].abs_diff(p[2]) < 40 && p[0] > 60 && !(p[0] > 240 && p[1] < 20)).count();
        let transparent = o.data.chunks(4).filter(|p| p[3] == 0).count();
        assert!(red > 1000, "screen visible: {red}");
        assert!(metal > 300, "metal side wall / rim visible: {metal}");
        assert!(transparent > 1000);
    }

    #[test]
    fn real_thickness_is_visible_in_3d() {
        // Same phone, but pretending to be 4x thicker must show a visibly larger side wall.
        let thin = dev("iphone-15-pro");
        let mut thick = thin.clone();
        thick.body.d *= 4.0;
        let area = |d: &Device| {
            let o = render(d, &params(Orientation::Left, None, 0.15)).unwrap();
            o.data.chunks(4).filter(|p| p[3] > 128).count()
        };
        assert!(area(&thick) > area(&thin));
    }

    #[test]
    fn every_bundled_device_renders_every_orientation() {
        for d in &bundled().devices {
            for name in &d.orientations {
                let o = Orientation::parse(name).unwrap();
                let out = render(d, &params(o, None, 0.05)).unwrap_or_else(|e| panic!("{} {name}: {e}", d.id));
                let opaque = out.data.chunks(4).filter(|p| p[3] > 200).count();
                let clear = out.data.chunks(4).filter(|p| p[3] == 0).count();
                assert!(opaque > 20 && clear > 0, "{} {name}: opaque {opaque}, clear {clear}", d.id);
            }
        }
    }

    #[test]
    fn laptop_front_shows_screen_above_keyboard() {
        let d = dev("macbook-pro-14");
        let img = solid(40, 26, [0, 200, 0, 255]);
        let o = render(&d, &params(Orientation::Front, Some(Image { rgba: &img, w: 40, h: 26 }), 0.15)).unwrap();
        let green: Vec<u32> = (0..o.height).filter(|&y| (0..o.width).any(|x| px(&o, x, y)[1] > 180 && px(&o, x, y)[0] < 60)).collect();
        assert!(!green.is_empty(), "screenshot visible");
        // base (deck) occupies the area below the screen
        let lowest_green = *green.last().unwrap();
        assert!(o.height - lowest_green > o.height / 12, "deck visible below screen");
    }

    #[test]
    fn flat_and_3d_front_views_agree() {
        // The 3D rasterizer front view of a phone (viewed straight on) must closely match the flat path.
        let d = dev("galaxy-s24-ultra");
        let img = solid(40, 80, [10, 120, 220, 255]);
        let flat = render(&d, &params(Orientation::Portrait, Some(Image { rgba: &img, w: 40, h: 80 }), 0.2)).unwrap();
        let spec_scale = 0.2;
        let mesh = crate::mesh::build(&d);
        let cam = crate::raster::Camera { rot: crate::mesh::rot_x(0.0), dist: 1.0e6 };
        let proj = crate::raster::project(&mesh, &cam, d.derived().ppm * spec_scale, MAX_SIDE, MAX_PIXELS).unwrap();
        let shot = crate::front::prepare_shot(&Image { rgba: &img, w: 40, h: 80 }, Fit::Cover, d.screen.w as f32, d.screen.h as f32, d.screen.w as f32 * spec_scale).unwrap();
        let spec = crate::front::FrontSpec::new(&d, 0, false, Some(shot)).unwrap();
        let sh = crate::raster::Shading { front: spec, metal: [0.7; 3], deck: (1.0, 1.0) };
        let data = crate::raster::rasterize(&proj, &sh);
        // sizes agree within the button margin, and the screen centre has the same colour
        assert!((proj.width as i32 - flat.width as i32).abs() <= 8, "{} vs {}", proj.width, flat.width);
        let c3 = &data[(((proj.height / 2) * proj.width + proj.width / 2) * 4) as usize..][..4];
        assert_eq!(c3, &px(&flat, flat.width / 2, flat.height / 2));
    }
}
