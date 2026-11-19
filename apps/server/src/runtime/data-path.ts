import path from 'node:path';

export function resolveDataDirectory(projectRoot: string, configuredRoot?: string): string {
  // Launchers and terminals can have a different cwd after moving a checkout.
  const directory = configuredRoot === undefined || configuredRoot === '' ? 'data' : configuredRoot;
  return path.resolve(projectRoot, directory);
}
