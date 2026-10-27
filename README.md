# Mockup

Fast, private device mockups in the browser, following the MockUPhone workflow: pick a device, drop screenshots, download. **Generate** renders every orientation of the device for every screenshot and delivers one zip. File names end in the orientation, e.g. `login-galaxy-s24-ultra-right.png`.

The renderer is Rust compiled to WebAssembly, running in a pool of Web Workers. Screenshots never leave the machine.

## What is implemented

- **Devices (13):** Galaxy S24 Ultra, Galaxy S24, iPhone 15 Pro, Pixel 8 Pro, iPad Pro 11" (M5), generic phone/tablet, MacBook Pro 14"/16", MacBook Air 13"/15", Surface Laptop 13.5", iMac 24".
- **Real 3D, real thickness:** bodies are rounded rectangles extruded to the published thickness with a filleted edge and smooth normals; side buttons, an open laptop (lid + base with keyboard and trackpad) and an iMac with chin and stand are modelled. Rendered by a tiled, z-buffered software rasterizer with 2x2 supersampling.
- **Orientations:** phones/tablets `portrait, landscape, right, left` (right/left are tilted 3D views); laptops and iMac `front, right, left`.
- **Import:** multiple files at once via picker, drag-and-drop anywhere, or paste. PNG/JPEG/WebP.
- **Export:** PNG (transparent), WebP, JPEG; Large (native, max 4096 px), Medium 2048, Small 1024. Always one zip.
- **Fit modes:** fill (crop), fit inside, stretch.
- **Backgrounds and shadows:** transparent, solid, 6 gradient presets plus a custom two-colour gradient with angle; padding (none/small/medium/large); soft, floating and contact shadows with a strength slider. Shadows are blurred from the device's own silhouette (two layers: ambient + contact), the canvas grows to fit, and the choice is remembered in the browser. Defaults: transparent background, small padding, soft shadow.

## Dimension data

All sizes are millimetres in `core/devices.json` (schema v2). Every device lists per-field `sources`:

- `fetched` – read from a manufacturer or spec site (URL recorded). Body size, thickness, screen diagonal and resolution come from here.
- `estimated` – not published (corner radii, edge fillet, bezel split, lid/base thickness split, stand shape, colours). Shown to users on each device page.
- `generic` – original design, no specific product.

Screen active area is derived from diagonal and resolution, never hand-entered. Phone sources: GSMArena (S24 Ultra, S24, iPhone 15 Pro, Pixel 8 Pro). Apple spec pages: MacBook Pro, MacBook Air, iMac, iPad Pro. Surface Laptop: Microsoft figures as reported by nanoreview.net.

## Frame geometry source

The S24 Ultra rim, bezel and corner values were measured from a MockUPhone export supplied by the project owner (79 mm body = 1027 px: corner radius ~0.5-1 mm, flat rim ~1.2-1.5 mm, bezel to screen ~3.3 mm at the sides, camera ring ~3.4 mm below the screen top). Only those dimensions were used; no MockUPhone frame pixels are bundled. Other devices use published body sizes with estimated rim/corner values (marked `estimated`).

Why not bundle MockUPhone's frame images: the `oursky/mockuphone.com` repository is Apache-2.0, but that covers its code. It does not say where the device images come from or under what terms (its README credits Facebook Design Resources), and they depict manufacturers' products. Add licensed PNG frames only after confirming their terms for commercial redistribution.

## Known limitations

- Frames are original artwork, not manufacturer renders. They are accurate in size and proportion, but details such as camera bumps, speaker grills, hinge shape, logos and the exact curved iMac stand are simplified or absent.
- No multi-device canvas yet; PSD input is not supported. Shadows are drop shadows from the silhouette, not a physically modelled ground plane.
- Estimated values (above) are not measured from real products.
- Trademarks: product names are used descriptively; no logos are drawn. Review brand/trade-dress guidance before selling.

## Requirements

Rust stable with `wasm32-unknown-unknown`, `wasm-bindgen-cli` 0.2.129 (`cargo install wasm-bindgen-cli --version 0.2.129 --locked`), Node 20+, Chrome (only for the e2e test).

## Commands

```sh
ln -sf "$PWD/scripts/mockup" ~/.local/bin/mockup   # once; ~/.local/bin must be on PATH
mockup                                             # builds if needed, serves, opens the browser
mockup --port 8080 --no-open --rebuild

scripts/build-wasm.sh                              # Rust -> web/src/wasm
cd web && npm install && npm run dev               # dev server
npm run build                                      # typecheck + production build
cargo test --release                               # Rust tests (manifest, mesh, render)
cd e2e && npm install && node run.mjs              # real-Chrome upload -> generate -> zip check
cargo run --release --example bench                # native render timings
cargo run --release --example bench_compose        # native background/shadow timings
```

## Measured performance (Intel i5-10310U laptop, 1.7 GHz)

Native render time at full size (screen at native resolution):

| device | views | per render |
| --- | --- | --- |
| Galaxy S24 Ultra 1604x3261 | portrait / landscape / tilted | 0.4 / 0.5 / 0.7 s |
| MacBook Pro 14" ~2500x1900 (scale 0.62) | front / right / left | 0.5 s each |
| iMac 24" ~3600x3000 (scale 0.75) | front / right / left | 1.1-1.4 s |

In headless Chrome, `e2e/run.mjs` generates two screenshots across all orientations (encoded as PNG, zipped): 8 phone mockups in 4.5 s, 6 MacBook Pro mockups in 6.9 s, 6 iMac mockups in 10.8 s.

## Layout

- `core/` – Rust crate: manifest, face shader (`front`), meshes (`mesh`), rasterizer (`raster`), orchestration (`render`), wasm bindings
- `web/` – Vite + TypeScript UI, worker pool (`engine.ts`, `worker.ts`), zip writer
- `e2e/` – browser end-to-end checks
