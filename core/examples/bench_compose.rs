use mockup_core::{compose::*, manifest::{bundled, find}, render::*};
fn main() {
    let m = bundled(); let d = find(&m, "galaxy-s24-ultra").unwrap();
    let t = std::time::Instant::now();
    let out = render(d, &Params { finish: 0, orientation: Orientation::Portrait, fit: Fit::Cover, scale: 1.0, screenshot: None }).unwrap();
    println!("render {}x{}: {:?}", out.width, out.height, t.elapsed());
