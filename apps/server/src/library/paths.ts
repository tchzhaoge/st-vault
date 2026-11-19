import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { libraryIdPattern } from './files.js';

export function libraryIndexPath(
  dataRoot: string,
  mediaRoot = path.join(dataRoot, 'media'),
): string {
  const manifest = JSON.parse(readFileSync(path.join(mediaRoot, 'library.json'), 'utf8')) as {
    id: string;
  };
  if (!libraryIdPattern.test(manifest.id)) throw Error('INVALID_LIBRARY_MANIFEST');
  return path.join(dataRoot, 'indexes', manifest.id);
}
export function subjectDirectory(mediaRoot: string, id: string): string {
  if (!/^stripchat:[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id.slice(10))))
    throw Error('INVALID_SUBJECT_ID');
  return path.join(mediaRoot, 'subjects', `stripchat-${id.slice(10)}`);
}
export function subjectImagePath(mediaRoot: string, id: string, kind: 'cover' | 'avatar'): string {
  return path.join(subjectDirectory(mediaRoot, id), 'images', `${kind}.img`);
}
export function snapshotFilePath(
  mediaRoot: string,
  job: { subject: string; unit?: string; at: number; end: number },
): string {
  if (
    ![job.at, job.end].every(Number.isSafeInteger) ||
    job.at < 0 ||
    job.end <= job.at ||
    job.end - job.at > 86460000
  )
    throw Error('INVALID_SCREENSHOT_JOB');
  const timestamp = new Date(job.at).toISOString();
  const unit = job.unit ? '-' + createHash('sha256').update(job.unit).digest('hex') : '';
  return path.join(
    subjectDirectory(mediaRoot, job.subject),
    'thumbnails',
    timestamp.slice(0, 10),
    timestamp.slice(11, 13),
    `${job.at}-${job.end}${unit}.jpg`,
  );
}
