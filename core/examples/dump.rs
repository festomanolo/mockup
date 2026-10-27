//! Renders every orientation of a device to PPM files (alpha composited on gray) for eyeballing.
//! usage: dump <device-id> <out-dir>   (env S = scale, default 0.12)
use mockup_core::{manifest::{bundled, find}, render::*};
use std::io::Write;

fn main() {
    let id = std::env::args().nth(1).unwrap_or("galaxy-s24-ultra".into());
    let dir = std::env::args().nth(2).unwrap_or(".".into());
    let scale: f32 = std::env::var("S").ok().and_then(|v| v.parse().ok()).unwrap_or(0.12);
    let m = bundled();
    let d = find(&m, &id).expect("device");
    // optional screenshot: PPM-less synthetic stripes so the screen is recognisable
    // SHOT=<raw rgba file> SW=<w> SH=<h> uses a real screenshot instead
    if let Ok(path) = std::env::var("SHOT") {
        let img = std::fs::read(path).unwrap();
        let iw: u32 = std::env::var("SW").unwrap().parse().unwrap();
        let ih: u32 = std::env::var("SH").unwrap().parse().unwrap();
        return dump(d, &id, &dir, scale, &img, iw, ih);
    }
    let (iw, ih) = (200u32, (200.0 * d.screen.h as f32 / d.screen.w as f32) as u32);
    let mut img = vec![255u8; (iw * ih * 4) as usize];
    for y in 0..ih { for x in 0..iw {
        let i = ((y * iw + x) * 4) as usize;
        img[i] = (x * 255 / iw) as u8; img[i + 1] = (y * 255 / ih) as u8; img[i + 2] = if (x / 20 + y / 20) % 2 == 0 { 220 } else { 90 };
    } }
    for name in &d.orientations {
        let o = Orientation::parse(name).unwrap();
        let t = std::time::Instant::now();
        let out = render(d, &Params { finish: 0, orientation: o, fit: Fit::Cover, scale, screenshot: Some(Image { rgba: &img, w: iw, h: ih }) }).unwrap();
        eprintln!("{id} {name}: {}x{} in {:?}", out.width, out.height, t.elapsed());
        let mut f = std::fs::File::create(format!("{dir}/{id}-{name}.ppm")).unwrap();
        write!(f, "P6\n{} {}\n255\n", out.width, out.height).unwrap();
        for p in out.data.chunks(4) {
            let a = p[3] as f32 / 255.0;
            let px = [0, 1, 2].map(|i| (p[i] as f32 * a + 205.0 * (1.0 - a)) as u8);
            f.write_all(&px).unwrap();
        }
    }
}
