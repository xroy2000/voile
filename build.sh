#!/usr/bin/env bash
# Compile le moteur en WebAssembly et génère web/pkg. Prérequis :
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.130 --locked
set -euo pipefail
cd "$(dirname "$0")"
cargo build --release --target wasm32-unknown-unknown -p regatta-web
wasm-bindgen --target web --no-typescript --out-dir web/pkg target/wasm32-unknown-unknown/release/regatta_web.wasm
ls -la web/pkg
