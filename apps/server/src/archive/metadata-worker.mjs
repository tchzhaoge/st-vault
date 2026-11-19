// Development worker resolves TypeScript module specifiers; release build replaces
// this entry with a direct import of compiled JavaScript and ships no TS loader.
import { register } from 'tsx/esm/api';
register();
await import('./metadata-worker.ts');
