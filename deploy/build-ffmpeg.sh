#!/bin/sh
set -eu
cd /source/ffmpeg-*/
./configure --prefix=/out --disable-autodetect --disable-hwaccels --disable-doc --disable-debug \
  --disable-ffplay --disable-ffprobe --disable-avdevice --disable-postproc \
  --disable-network --disable-encoders --enable-encoder=mjpeg,rawvideo \
  --disable-muxers --enable-muxer=image2pipe,rawvideo \
  --disable-demuxers --enable-demuxer=mov,mjpeg \
  --disable-protocols --enable-protocol=pipe \
  --disable-filters --enable-filter=trim,scale,format,null \
  --enable-libdav1d
make -j2
make install
# Keep the exact patched source and configuration with the redistributable
# executable. No compiler, headers or static development libraries enter runtime.
mkdir -p /out/share/doc/ffmpeg
cp COPYING.LGPLv2.1 LICENSE.md /out/share/doc/ffmpeg/
cp ffbuild/config.log /out/share/doc/ffmpeg/config.log
make distclean
tar -czf /out/share/doc/ffmpeg/source.tar.gz -C /source "$(basename "$PWD")"
rm -rf /out/include /out/lib /out/share/ffmpeg
