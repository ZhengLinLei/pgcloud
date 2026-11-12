#!/usr/bin/env bash
# Downloads the fonts of the book (SIL Open Font License) from github.com/google/fonts into ./fonts.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p fonts
for f in Spectral-Light Spectral-LightItalic Spectral-Regular Spectral-Medium; do
  curl -fsSL -o "fonts/$f.ttf" "https://github.com/google/fonts/raw/main/ofl/spectral/$f.ttf"
done
curl -fsSL -o fonts/Inconsolata.ttf "https://github.com/google/fonts/raw/main/ofl/inconsolata/Inconsolata%5Bwdth%2Cwght%5D.ttf"
ls fonts
