import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const root =
  process.env.STV_BUILD_ROOT ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../build');
const { migrateLibrary } = await import(
  pathToFileURL(path.join(root, 'apps/server/src/library/migrate.js')).href
);
const [source, data, media] = process.argv.slice(2);
if (!source || !data || !media)
  throw Error(
    'Usage: migrate-library.mjs SOURCE_DATA NEW_DATA NEW_MEDIA (stop the application first)',
  );
await migrateLibrary({
  source,
  data,
  media,
  progress: (stage, done) => console.log(JSON.stringify({ stage, done })),
});
