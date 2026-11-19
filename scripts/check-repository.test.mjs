import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkMarkdown, checkSourceBoundaries } from './check-repository.mjs';

async function fixture(files, run) {
  const root = await mkdtemp(path.join(tmpdir(), 'stv-repository-'));
  try {
    for (const [name, value] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), value);
    }
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test('validates relative documentation links without fetching external URLs or parsing code samples', async () => {
  await fixture(
    {
      'README.md':
        '[guide](docs/guide.md#section) [remote](https://example.invalid)\n```md\n[example](missing.md)\n```',
      'docs/guide.md': '# Guide',
    },
    (root) => assert.deepEqual(checkMarkdown(root, 'README.md'), []),
  );
});
test('rejects broken and machine-specific documentation links', async () => {
  await fixture({ 'README.md': '[missing](missing.md) [local](D:/private/notes.md)' }, (root) =>
    assert.equal(checkMarkdown(root, 'README.md').length, 2),
  );
});

test('checks HTML language switches and hero images as local documentation links', async () => {
  await fixture(
    {
      'README.md': '<a href="docs/index.en.md">English</a><img src="missing.png" alt="Logo">',
      'docs/index.en.md': '<a href="../README.md">中文</a>',
    },
    (root) => {
      assert.deepEqual(checkMarkdown(root, 'README.md'), ['README.md: broken link missing.png']);
      assert.deepEqual(checkMarkdown(root, 'docs/index.en.md'), []);
    },
  );
});
test('rejects shared-to-feature dependencies and runtime cycles', async () => {
  const files = {
    'apps/ui/src/shared/a.ts': "import { b } from '../features/b'; export const a = b;",
    'apps/ui/src/features/b.ts': "import { a } from '../shared/a'; export const b = a;",
  };
  await fixture(files, (root) => {
    const failures = checkSourceBoundaries(root, Object.keys(files));
    assert(failures.some((failure) => failure.includes('shared code depends')));
    assert(failures.some((failure) => failure.includes('Runtime import cycle')));
  });
});
test('accepts ESM .js references to TypeScript and excludes type-only cycles', async () => {
  const files = {
    'apps/server/src/a.ts': "import type { B } from './b.js'; export interface A { b: B }",
    'apps/server/src/b.ts': "import type { A } from './a.js'; export interface B { a: A }",
  };
  await fixture(files, (root) =>
    assert.deepEqual(checkSourceBoundaries(root, Object.keys(files)), []),
  );
});
test('accepts NodeNext .mjs references to explicit ESM TypeScript helpers', async () => {
  const files = {
    'apps/server/src/unit.test.ts':
      "import { fixture } from '../../../tests/support/fixture.mjs';fixture();",
    'tests/support/fixture.mts': 'export const fixture=()=>undefined;',
  };
  await fixture(files, (root) =>
    assert.deepEqual(checkSourceBoundaries(root, Object.keys(files)), []),
  );
});
