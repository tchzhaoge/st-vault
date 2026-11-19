import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const archiveName = 'runtime-image.tar',
  manifestName = 'manifest.json';
const sha256 = /^sha256:[a-f0-9]{64}$/;
const revisionPattern = /^[a-f0-9]{40,64}$/;
const architectures = new Set(['amd64', 'arm64']);
const archiveTag = (architecture) => `st-vault:verified-${architecture}`;
const validLayers = (layers) =>
  Array.isArray(layers) && layers.length > 0 && layers.every((layer) => sha256.test(layer));
function docker(args) {
  const result = spawnSync('docker', args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw Error(`DOCKER_${args[0].toUpperCase()}_FAILED: ${result.stderr.slice(0, 1024)}`);
  return result.stdout;
}
async function hash(filename) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}
function imageInfo(raw, expectedRevision) {
  const [image] = JSON.parse(raw);
  const revision = image?.Config?.Labels?.['org.opencontainers.image.revision'] || null;
  if (
    !image ||
    !sha256.test(image.Id) ||
    image.Os !== 'linux' ||
    !architectures.has(image.Architecture) ||
    !validLayers(image.RootFS?.Layers)
  )
    throw Error('INVALID_RUNTIME_IMAGE');
  if (revision !== null && !revisionPattern.test(revision)) throw Error('INVALID_IMAGE_REVISION');
  if (expectedRevision && revision !== expectedRevision) throw Error('IMAGE_REVISION_MISMATCH');
  return {
    imageId: image.Id,
    revision,
    architecture: image.Architecture,
    layers: image.RootFS.Layers,
  };
}
function expectArchitecture(image, expected = process.env.STV_IMAGE_ARCH) {
  if (expected && image.architecture !== expected) throw Error('IMAGE_ARCHITECTURE_MISMATCH');
}
export async function exportImage(
  image,
  directory,
  run = docker,
  expectedRevision = process.env.GITHUB_SHA,
) {
  const identity = imageInfo(await run(['image', 'inspect', image]), expectedRevision);
  expectArchitecture(identity);
  await mkdir(directory, { recursive: true });
  const archive = path.join(directory, archiveName);
  const tag = archiveTag(identity.architecture);
  // An image saved by daemon ID has no named reference for the other runner to restore.
  await run(['image', 'tag', image, tag]);
  await run(['image', 'save', '--output', archive, tag]);
  const manifest = { format: 3, ...identity, archiveSha256: await hash(archive) };
  await writeFile(path.join(directory, manifestName), JSON.stringify(manifest) + '\n');
  return manifest;
}
export async function verifyArtifact(
  directory,
  expectedRevision = process.env.GITHUB_SHA,
  expectedArchitecture = process.env.STV_IMAGE_ARCH,
) {
  const filename = path.join(directory, manifestName);
  if ((await stat(filename)).size > 16384) throw Error('INVALID_IMAGE_MANIFEST');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  if (
    manifest.format !== 3 ||
    !sha256.test(manifest.imageId) ||
    !architectures.has(manifest.architecture) ||
    !validLayers(manifest.layers) ||
    !/^[a-f0-9]{64}$/.test(manifest.archiveSha256) ||
    (manifest.revision !== null &&
      (typeof manifest.revision !== 'string' || !revisionPattern.test(manifest.revision)))
  )
    throw Error('INVALID_IMAGE_MANIFEST');
  if (expectedRevision && manifest.revision !== expectedRevision)
    throw Error('IMAGE_REVISION_MISMATCH');
  expectArchitecture(manifest, expectedArchitecture);
  if ((await hash(path.join(directory, archiveName))) !== manifest.archiveSha256)
    throw Error('IMAGE_ARCHIVE_MISMATCH');
  return manifest;
}
export async function loadImage(
  directory,
  run = docker,
  expectedRevision = process.env.GITHUB_SHA,
) {
  const manifest = await verifyArtifact(directory, expectedRevision);
  await run(['image', 'load', '--input', path.join(directory, archiveName)]);
  const actual = imageInfo(
    await run(['image', 'inspect', archiveTag(manifest.architecture)]),
    expectedRevision,
  );
  expectArchitecture(actual, manifest.architecture);
  if (
    actual.revision !== manifest.revision ||
    JSON.stringify(actual.layers) !== JSON.stringify(manifest.layers)
  )
    throw Error('LOADED_IMAGE_MISMATCH');
  return manifest;
}
export async function publishImage(
  directory,
  tags,
  run = docker,
  expectedRevision = process.env.GITHUB_SHA,
) {
  if (
    !tags.length ||
    tags.some((tag) => !/^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tag))
  )
    throw Error('INVALID_IMAGE_TAG');
  const manifest = await loadImage(directory, run, expectedRevision);
  for (const tag of tags) {
    await run(['image', 'tag', archiveTag(manifest.architecture), tag]);
    await run(['image', 'push', tag]);
  }
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2);
  let result;
  if (command === 'export' && args.length === 2) result = await exportImage(args[0], args[1]);
  else if (command === 'check' && args.length === 1) result = await verifyArtifact(args[0]);
  else if (command === 'load' && args.length === 1) result = await loadImage(args[0]);
  else if (command === 'publish' && args.length >= 2)
    result = await publishImage(args[0], args.slice(1));
  else throw Error('INVALID_RELEASE_COMMAND');
  console.log(JSON.stringify(result));
}
