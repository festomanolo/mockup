use mockup_core::{compose::*, manifest::{bundled, find}, render::*};
fn main() {
    let m = bundled(); let d = find(&m, "galaxy-s24-ultra").unwrap();
    let t = std::time::Instant::now();
    let out = render(d, &Params { finish: 0, orientation: Orientation::Portrait, fit: Fit::Cover, scale: 1.0, screenshot: None }).unwrap();
    println!("render {}x{}: {:?}", out.width, out.height, t.elapsed());
    for (name, json) in [("transparent+soft shadow", r#"{"shadow":"soft","padding":0.06}"#), ("gradient+soft", r##"{"bg":{"kind":"linear","from":"#4facfe","to":"#00f2fe","angle":135},"shadow":"soft","padding":0.06}"##), ("solid, no shadow", r##"{"bg":{"kind":"solid","color":"#ffffff"},"padding":0.06}"##)] {
        let st = parse_style(json).unwrap();
        let t = std::time::Instant::now();
