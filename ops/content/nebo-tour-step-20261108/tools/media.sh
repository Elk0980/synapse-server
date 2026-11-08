#!/bin/sh
# Бесшовная петля облаков из ролика Gemini (10 с): последние 2 с плавно перетекают в начало.
# sh media.sh <вход.mp4> <выход.mp4> <ширина>   (локально, ffmpeg)
set -e
IN=$1; OUT=$2; W=${3:-1280}
D=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$IN")
F=2
ffmpeg -y -v error -i "$IN" -filter_complex "\
[0:v]scale=${W}:-2,fps=24,split[a][b];\
[a]trim=start=${F},setpts=PTS-STARTPTS[body];\
[b]trim=0:${F},setpts=PTS-STARTPTS[head];\
[body][head]xfade=transition=fade:duration=${F}:offset=$(echo "$D - 2*$F" | bc -l)[v]" \
 -map "[v]" -an -c:v libx264 -preset veryfast -crf 26 -pix_fmt yuv420p -movflags +faststart "$OUT"
ls -l "$OUT"
