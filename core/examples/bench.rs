use mockup_core::{manifest::{bundled, find}, render::*};
fn main() {
    let m = bundled();
    let img = vec![[120u8, 90, 200, 255]; 1000 * 2000].concat();
    for (id, scale) in [("galaxy-s24-ultra", 1.0f32), ("macbook-pro-14", 0.62), ("imac-24", 0.75)] {
        let d = find(&m, id).unwrap();
        for name in &d.orientations {
            let o = Orientation::parse(name).unwrap();
            let t = std::time::Instant::now();
            let out = render(d, &Params { finish: 0, orientation: o, fit: Fit::Cover, scale, screenshot: Some(Image { rgba: &img, w: 1000, h: 2000 }) }).unwrap();
            println!("{id:18} {name:10} {}x{} {:>6.0} ms", out.width, out.height, t.elapsed().as_secs_f64() * 1000.0);
        }
    }
}
