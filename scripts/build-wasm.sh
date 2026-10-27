#!/usr/bin/env bash
# Builds the Rust core to WebAssembly and generates JS bindings into web/src/wasm.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown -p mockup-core --features wasm
wasm-bindgen --target web --out-dir web/src/wasm target/wasm32-unknown-unknown/release/mockup_core.wasm
