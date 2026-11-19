import { readFileSync } from 'node:fs';

export function parseBuildInfo(
  manifest: unknown,
  revision?: string,
): { version: string; revision: string | null } {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    !('version' in manifest) ||
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(manifest.version)
  )
    throw Error('INVALID_BUILD_MANIFEST');
  if (revision && !/^[a-f0-9]{40,64}$/.test(revision)) throw Error('INVALID_BUILD_REVISION');
  return { version: manifest.version, revision: revision === '' ? null : (revision ?? null) };
}

// Both native source and emitted releases carry this server manifest. Private
// configuration and the current checkout directory never determine build identity.
export const buildInfo = parseBuildInfo(
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as unknown,
  process.env.STV_BUILD_REVISION,
);
