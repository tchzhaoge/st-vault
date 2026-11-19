// Run in the candidate runtime, with synthetic MP4s mounted at /fixtures.
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const app = process.env.STV_PROBE_APP_ROOT ?? '/app';
const load = (file) => import(pathToFileURL(path.join(app, 'apps/server/src', file)).href);
const execute = promisify(execFile);
const acceleration = await execute('ffmpeg', ['-hide_banner', '-hwaccels']);
assert.match(acceleration.stdout.trim(), /^Hardware acceleration methods:$/);
for (const tool of [
  'npm',
  'npx',
  'yarn',
  'gcc',
  'make',
  'ffprobe',
  'chromium',
  'chromium-headless-shell',
]) {
  const result = await execute('sh', ['-c', 'command -v "$1" || true', 'sh', tool]);
  assert.equal(result.stdout.trim(), '', `${tool} unexpectedly present in runtime`);
}
const { createFfmpegDecoder, verifyJpeg } = await load('previews/ffmpeg.js');
const codecs = [];
for (const codec of ['h264', 'hevc', 'vp9', 'av1']) {
  const filename = `/fixtures/${codec}.mp4`;
  await access(filename);
  const signal = AbortSignal.timeout(15000);
  const image = await createFfmpegDecoder()({
    paths: [filename],
    offsetSeconds: 0,
    endSeconds: 1,
    signal,
  });
  await verifyJpeg(image, signal);
  await assert.rejects(verifyJpeg(Buffer.from([255, 216, 255, 217]), signal));
  codecs.push({ codec, screenshotBytes: image.length, jpegVerified: true });
}
console.log(
  JSON.stringify({
    passed: true,
    codecs,
    softwareOnly: true,
    browserAbsent: true,
    toolsAbsent: true,
  }),
);
