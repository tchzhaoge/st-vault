import { expect, it } from 'vitest';
import { rankedVariants } from './quality.js';
import { parseMaster } from './hls.js';
const variants = parseMaster(
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1080x1920\nportrait.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=20000000,RESOLUTION=3840x2160\n4k.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080\nlandscape.m3u8\n',
  'https://fixture.invalid/master.m3u8',
).variants;
it('selects highest first without mutating source order or excluding high-bitrate and portrait tiers', () => {
  expect(rankedVariants(variants)[0].height).toBe(2160);
  expect(rankedVariants(variants).map((value) => value.url.split('/').at(-1))).toEqual([
    '4k.m3u8',
    'portrait.m3u8',
    'landscape.m3u8',
    'low.m3u8',
  ]);
  expect(variants[0].height).toBe(360);
});
it('uses bitrate when dimensions are unknown and accepts an empty list', () => {
  expect(
    rankedVariants([
      { url: 'a', height: 0, width: 0, bandwidth: 1 },
      { url: 'b', height: 0, width: 0, bandwidth: 2 },
    ])[0].url,
  ).toBe('b');
  expect(rankedVariants([])).toEqual([]);
});
