import { jpeg } from './ffmpeg.js';

export type PreviewImageType = 'image/jpeg' | 'image/png' | 'image/webp';
/** Identify bounded raster payloads from bytes, never from a URL or untrusted MIME. */
export function previewImageType(bytes: Uint8Array): PreviewImageType | null {
  if (jpeg(bytes)) return 'image/jpeg';
  if (
    bytes.length >= 24 &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) &&
    bytes[12] === 73 &&
    bytes[13] === 72 &&
    bytes[14] === 68 &&
    bytes[15] === 82
  )
    return 'image/png';
  if (
    bytes.length >= 20 &&
    bytes[0] === 82 &&
    bytes[1] === 73 &&
    bytes[2] === 70 &&
    bytes[3] === 70 &&
    bytes[8] === 87 &&
    bytes[9] === 69 &&
    bytes[10] === 66 &&
    bytes[11] === 80
  ) {
    const declared = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
      4,
      true,
    );
    if (
      declared + 8 === bytes.length &&
      bytes[12] === 86 &&
      bytes[13] === 80 &&
      bytes[14] === 56 &&
      [32, 76, 88].includes(bytes[15])
    )
      return 'image/webp';
  }
  return null;
}
