import path from 'node:path';
import { installRuntimeLogs } from '../runtime/runtime-logs.js';

installRuntimeLogs(
  path.resolve(process.env.STV_LOG_DIR ?? path.join(process.env.STV_DATA_DIR ?? '/data', 'logs')),
  'app',
);
await import('../index.js');
