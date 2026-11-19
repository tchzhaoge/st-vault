import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportImage, loadImage, publishImage, verifyArtifact } from './release-image.mjs';

const imageId = 'sha256:' + 'a'.repeat(64),
  layerId = 'sha256:' + 'e'.repeat(64),
  revision = 'b'.repeat(40);
const inspected = (id = imageId, architecture = 'amd64', layer = layerId) =>
  JSON.stringify([
    {
      Id: id,
      Os: 'linux',
      Architecture: architecture,
      Config: { Labels: { 'org.opencontainers.image.revision': revision } },
      RootFS: { Layers: [layer] },
    },
  ]);
async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'stv-release-'));
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    if (args[1] === 'save') await writeFile(args[3], 'synthetic image archive');
    return args[1] === 'inspect' ? inspected() : '';
  };
  try {
    await run({ directory, calls, docker });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('publishes the checked image by its restored archive tag even across different image stores', async () =>
  fixture(async ({ directory, calls, docker }) => {
    const exported = await exportImage('st-vault:runtime', directory, docker, revision);
    const archiveTag = 'st-vault:verified-amd64';
    assert.deepEqual(calls.find((args) => args[1] === 'save')?.slice(-1), [archiveTag]);
    calls.length = 0;
    const restored = (args) => {
      if (args[1] === 'inspect') {
        assert.equal(args[2], archiveTag);
        return inspected('sha256:' + 'd'.repeat(64));
      }
      return docker(args);
    };
    await publishImage(
      directory,
      ['ghcr.io/example/st-vault:latest', 'ghcr.io/example/st-vault:sha-123'],
      restored,
      revision,
    );
    assert.equal(exported.imageId, imageId);
    assert(calls.some((args) => args[1] === 'load'));
    assert.equal(calls.filter((args) => args[1] === 'push').length, 2);
    assert(calls.filter((args) => args[1] === 'tag').every((args) => args[2] === archiveTag));
    assert(!calls.some((args) => args.includes('build')));
  }));
test('rejects tampering before loading or pushing an image', async () =>
  fixture(async ({ directory, calls, docker }) => {
    await exportImage('st-vault:runtime', directory, docker, revision);
    await writeFile(path.join(directory, 'runtime-image.tar'), 'tampered');
    calls.length = 0;
    await assert.rejects(() => loadImage(directory, docker, revision), /IMAGE_ARCHIVE_MISMATCH/);
    assert.deepEqual(calls, []);
  }));
test('accepts arm64 and rejects an artifact or loaded image for the wrong architecture', async () =>
  fixture(async ({ directory, docker }) => {
    const arm = (args) => (args[1] === 'inspect' ? inspected(imageId, 'arm64') : docker(args));
    const exported = await exportImage('st-vault:runtime', directory, arm, revision);
    assert.equal(exported.architecture, 'arm64');
    await verifyArtifact(directory, revision, 'arm64');
    await assert.rejects(
      () => verifyArtifact(directory, revision, 'amd64'),
      /IMAGE_ARCHITECTURE_MISMATCH/,
    );
    await assert.rejects(
      () => loadImage(directory, docker, revision),
      /IMAGE_ARCHITECTURE_MISMATCH/,
    );
    assert.equal((await loadImage(directory, arm, revision)).architecture, 'arm64');
  }));
test('rejects wrong revision or loaded identity before tagging', async () =>
  fixture(async ({ directory, calls, docker }) => {
    await exportImage('st-vault:runtime', directory, docker, revision);
    await assert.rejects(
      () => verifyArtifact(directory, 'c'.repeat(40)),
      /IMAGE_REVISION_MISMATCH/,
    );
    calls.length = 0;
    const changed = async (args) =>
      args[1] === 'inspect'
        ? inspected(imageId, 'amd64', 'sha256:' + 'f'.repeat(64))
        : docker(args);
    await assert.rejects(
      () => publishImage(directory, ['ghcr.io/example/st-vault:latest'], changed, revision),
      /LOADED_IMAGE_MISMATCH/,
    );
    assert(!calls.some((args) => args[1] === 'tag' || args[1] === 'push'));
  }));
