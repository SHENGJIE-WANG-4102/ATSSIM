#!/bin/sh
# Cut the two 02A05 inverter recordings the train sound plays from (src/ui/vvvf.ts)
# out of the source recording p02 (BV1VGZiBPEjt p2, 48 kHz WAV), into
# public/sounds/vvvf/. The recordings are third-party material and are not in
# the repository; the time ranges match the tables in src/data/vvvf.ts.
#   usage: scripts/vvvf-clips.sh path/to/p02.wav
set -e
src="${1:?usage: $0 path/to/p02.wav}"
out="$(dirname "$0")/../public/sounds/vvvf"
mkdir -p "$out"
# a complete start under power, and a complete electric-brake stop
ffmpeg -v error -y -ss 6.2 -to 39.6 -i "$src" -ac 1 -c:a libmp3lame -b:a 112k "$out/traction.mp3"
ffmpeg -v error -y -ss 66.0 -to 96.8 -i "$src" -ac 1 -c:a libmp3lame -b:a 112k "$out/brake.mp3"
echo "wrote $out/traction.mp3 and $out/brake.mp3"
