use mockup_core::{compose::*, manifest::{bundled, find}, render::*};
fn main() {
    let m = bundled(); let d = find(&m, "galaxy-s24-ultra").unwrap();
