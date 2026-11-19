import { z } from 'zod';
import type { ArchivePort } from '../ports.js';

const runtimeSettingsSchema = z.object({
  pollMs: z.number().int().min(1000).max(300000),
  retentionDays: z.number().int().min(0).max(3650),
  minFreeBytes: z
    .number()
    .int()
    .min(0)
    .max(2 ** 50),
});
export const settingsSchema = runtimeSettingsSchema.strict();
// Patch validation must not fill defaults for fields the caller did not send.
const settingsPatchSchema = runtimeSettingsSchema
  .strict()
  .partial()
  .refine((value) => Object.keys(value).length > 0);
export type RuntimeSettings = z.infer<typeof settingsSchema>;
export const defaultRuntimeSettings: RuntimeSettings = {
  pollMs: 5000,
  retentionDays: 0,
  minFreeBytes: 2 * 1024 ** 3,
};

export class SettingsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private constructor(
    private readonly archive: Pick<ArchivePort, 'getSetting' | 'setSetting'>,
    private value: RuntimeSettings,
  ) {}
  static async open(
    archive: Pick<ArchivePort, 'getSetting' | 'setSetting'>,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<SettingsStore> {
    const defaults = { ...defaultRuntimeSettings };
    for (const [key, name] of Object.entries({
      pollMs: 'STV_POLL_MS',
      retentionDays: 'STV_RETENTION_DAYS',
      minFreeBytes: 'STV_MIN_FREE_BYTES',
    })) {
      if (env[name] !== undefined) Object.assign(defaults, { [key]: Number(env[name]) });
    }
    const stored = await archive.getSetting('runtime.settings');
    return new SettingsStore(
      archive,
      runtimeSettingsSchema.parse(stored ? (JSON.parse(stored) as unknown) : defaults),
    );
  }
  get = (): RuntimeSettings => ({ ...this.value });
  update(patch: unknown): Promise<RuntimeSettings> {
    const parsed = settingsPatchSchema.parse(patch);
    const operation = this.queue.then(async () => {
      const next = settingsSchema.parse({ ...this.value, ...parsed });
      // Persist the complete validated settings atomically.
      await this.archive.setSetting('runtime.settings', JSON.stringify(next));
      this.value = next;
      return this.get();
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
