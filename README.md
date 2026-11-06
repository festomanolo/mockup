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
- **Galaxy S24 Ultra detail (tilted views):** camera angle fitted to MockUPhone's right/left exports (screen corners give a 44° tilt and 35° spin); grey cover-glass bezel with black hairlines, thin titanium lip and groove, rounder 3D corners, and a wall shader that paints the SIM tray and pin hole, mic, USB-C, speaker grille, S Pen, antenna bands and side buttons. Positions are measured from those exports and listed under `details` in `core/devices.json`, so other models can get the same treatment once measured.

## Guided studio (`/studio/`)

Upload raw screenshots once. They are placed in the selected device, and the most detailed, most distinct ones are suggested for the **video** (top 3 raw screens) and the **store listing** (up to 8). A duplicate/blank detector (perceptual hash + contrast) flags near-copies and empty screens, and transparent PNGs are recognised as **finished mockups**. You toggle Video / Store / Finished mockup per screenshot, then continue: the video studio plays the chosen screens on the 3D device in a cross-fading sequence, and the store listing starts with the store screens. The library lives for the browser session.

## Store listing studio (`/store/`)

Builds App Store and Google Play listing graphics and text.

- **Carousel screenshots** from 9 hand-built layouts (hero, big crop, text below, tilt, duo, rings, big type, and a two-slide *bridge* where a device and the background flow across the slide edge). Slides are drawn from one panorama, so seamless carousels line up exactly (tested: edge difference 0.6 vs 53 with seamless off). Devices come from the same Rust/WASM renderer as the stills page. Your own **finished mockups** are placed as they are, without another device frame.
- **Backgrounds**: gradient editor (linear/radial, angle, up to 6 colour stops with colour pickers and positions, presets, reverse, random), plus up to 3 **shape layers** from 18 styles (blobs, bubbles, rings, waves, dunes, diagonals, halftone, grid, triangles, honeycomb, sparkles, ribbons, arcs, aurora, confetti, flow lines, squares, scales), each with tone/custom colour, opacity, size and shuffle. Shapes flow continuously across slide edges. Text colour is automatic or a custom colour.
- **Optional AI writer**: describe the app and an OpenAI-compatible model (OpenRouter, a local Ollama, or any custom URL) drafts the headlines, sub-lines and store text (title, subtitle, short description, keywords, promo text, description, what's new) against the store character limits. The AI writes **words only**; every word stays editable, and single slides can be rewritten. Invalid answers are retried once. Only the text you typed is sent, never screenshots, and sending requires ticking a consent box. Keys stay in memory unless you tick "remember". For Ollama run `OLLAMA_ORIGINS=* ollama serve`.
- **Export ZIP**: iPhone 6.9" (1320×2868), iPhone 6.5" (1284×2778), iPad 13" (2064×2752), Google Play phone (1080×1920) and tablet (1600×2560), the 1024×500 feature graphic (JPEG, no alpha), a 512×512 icon, `listing-copy.txt` and a `listing.json` project file. Confirm sizes against App Store Connect / Play Console before uploading.
- Limitations: tablet sets reuse the phone screenshots (cropped to fill); screenshots are not stored in project files or kept after the tab is closed; no URL capture.

## Video mockups (`/video/<device>/`)

A second studio next to the stills: the device is rendered live in **WebGL (Three.js)** with a screenshot or screen recording on its screen, a camera animation on top, and exported as a video. Everything runs in the tab; nothing is uploaded. Reach it from the **Video** link in the header or the banner on any device page.

- **Devices:** all 13 from `core/devices.json`, rebuilt as Three.js geometry from the same measured dimensions (rounded slab with filleted edge, glass, screen, camera cut-out, side keys, open laptop lid and keyboard deck, iMac foot/neck). Finish colours, portrait/landscape for phones and tablets, adjustable screen gloss.
- **Screen media:** PNG/JPEG/WebP or MP4/WebM screen recordings (drop, paste or browse), fill/fit/stretch. Video frames are seeked per output frame at export, so they stay in sync however slow the machine is.
- **Camera:** 14 presets (hero reveal, push-in, pull-out, orbit 360°, half orbit, pan, tilts, spiral, pendulum, float, dutch roll, macro fly-through, static), duration, global easing override, field of view, idle float. **Custom keyframes**: edit time, turn/tilt/roll, zoom, pan and per-segment easing, add a key at the playhead, scrub the timeline.
- **Scene:** transparent / solid / 10 gradients / background image, four lighting presets, environment reflections (procedural studio map, no downloads), exposure, ground shadow.
- **Audio:** add a soundtrack (looped, volume, fade-out) or use the screen video's own sound; muxed into the file.
- **Export:** frame-by-frame (never real-time recording) through **WebCodecs**: MP4 (H.264) and WebM (VP9), 720p / 1080p / 1440p / 4K, 24/30/60 fps, 16:9, 9:16, 1:1, 4:5, 21:9, three quality levels. A transparent background exports WebM with alpha where the browser can encode it, otherwise a ZIP of transparent PNG frames (max 450 frames).

Limitations: no URL-to-scrolling-video capture (that needs a server-side headless browser, which would break the "nothing leaves your machine" promise); one device per scene; the 3D models are simplified original geometry (no camera bumps, logos, speaker grills); export needs a WebCodecs browser (Chrome/Edge; Safari 16.4+ for H.264); 4K export is limited by the browser's maximum canvas size and encoder level.

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
- No multi-device canvas yet (stills and video); PSD input is not supported. Shadows are drop shadows from the silhouette, not a physically modelled ground plane.
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
- `web/src/library.ts` – shared screenshot library (analysis, suggestions); `web/src/wizard/` – guided studio
- `web/src/store/` – store listing studio (`shapes.ts` = background shape styles): `model.ts` (targets, palettes, listing data), `templates.ts` (layouts), `render.ts` (Canvas drawing), `ai.ts` (text-only AI client), `storePage.ts` (UI); loaded lazily
- `web/src/video/` – video studio: `device3d.ts` (Three.js models), `animation.ts` (presets, easing, keyframes), `stage.ts` (renderer, lights, camera rig), `exporter.ts` (WebCodecs + muxers), `videoPage.ts` (UI); loaded lazily so the stills app stays small
- `e2e/` – browser end-to-end checks
