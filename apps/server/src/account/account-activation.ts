import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ArchivePort, SubjectInput } from '../ports.js';
import type { KeyVault } from '../http/key-vault.js';

export type AccountActivationArchive = Required<
  Pick<
    ArchivePort,
    | 'prepareAccountSubjects'
    | 'activateAccountSubjects'
    | 'accountActivation'
    | 'discardAccountPreparation'
    | 'identity'
  >
>;
interface Pending<T> {
  generation: string;
  libraryId: string;
  next: T | null;
}
interface Connection<T> {
  version: 2;
  active: T | null;
  pending: Pending<T> | null;
}
const envelopeSchema = z
  .object({
    version: z.literal(2),
    active: z.unknown(),
    pending: z
      .object({ generation: z.string().uuid(), libraryId: z.string().uuid(), next: z.unknown() })
      .strict()
      .nullable(),
  })
  .strict();

/** Recoverable activation across private credentials and the portable library.
 * A sealed pending record is the acceptance point. Public preparation contains
 * only imported subject metadata; credentials never enter the library journal. */
export class AccountActivation<T> {
  active: T | null = null;
  private pending: Pending<T> | null = null;
  private uncertain = false;
  constructor(
    private readonly options: {
      archive: AccountActivationArchive;
      vault: Pick<KeyVault, 'readSealedSecret' | 'writeSealedSecret'>;
      parse: (value: unknown) => T;
      changed: () => void;
    },
  ) {}
  get recovering(): boolean {
    return this.pending !== null || this.uncertain;
  }
  async load(): Promise<void> {
    const saved = await this.options.vault.readSealedSecret('account-sync');
    if (saved === null) {
      this.active = null;
      this.pending = null;
    } else {
      const value: unknown = JSON.parse(saved);
      if (
        typeof value === 'object' &&
        value !== null &&
        'version' in value &&
        value.version === 2
      ) {
        const envelope = envelopeSchema.parse(value);
        this.active = envelope.active === null ? null : this.options.parse(envelope.active);
        this.pending = envelope.pending
          ? {
              generation: envelope.pending.generation,
              libraryId: envelope.pending.libraryId,
              next:
                envelope.pending.next === null ? null : this.options.parse(envelope.pending.next),
            }
          : null;
      } else {
        // Existing private credentials are retained. Compatibility is confined
        // to this read boundary; all subsequent writes use the activation form.
        this.active = this.options.parse(value);
        this.pending = null;
      }
    }
    this.uncertain = false;
    this.options.changed();
  }
  private async write(active: T | null, pending: Pending<T> | null): Promise<void> {
    const value =
      active === null && pending === null
        ? null
        : JSON.stringify({ version: 2, active, pending } satisfies Connection<T>);
    try {
      await this.options.vault.writeSealedSecret('account-sync', value);
    } catch (error) {
      // A lost write acknowledgement is not proof of rollback. Read the private
      // authoritative record before deciding whether activation was accepted.
      let actual: string | null;
      try {
        actual = await this.options.vault.readSealedSecret('account-sync');
      } catch {
        this.uncertain = true;
        throw error;
      }
      if (actual !== value) throw error;
    }
  }
  async recover(): Promise<T | null> {
    if (this.uncertain) await this.load();
    const pending = this.pending;
    if (!pending) return this.active;
    if ((await this.options.archive.identity()).instanceId !== pending.libraryId)
      throw Error('ACCOUNT_ACTIVATION_LIBRARY_MISMATCH');
    if ((await this.options.archive.accountActivation()) !== pending.generation)
      await this.options.archive.activateAccountSubjects(pending.generation);
    // The library has published this generation. Even if final cleanup fails,
    // memory and restart both identify its matching credentials in pending.next.
    this.active = pending.next;
    this.options.changed();
    await this.write(this.active, null);
    this.pending = null;
    this.options.changed();
    return this.active;
  }
  async activate(
    subjects: SubjectInput[],
    next: T | null,
    validate: () => void,
    accepted: () => void,
    replaceForeignPending = false,
  ): Promise<void> {
    if (this.recovering && !replaceForeignPending) throw Error('ACCOUNT_ACTIVATION_PENDING');
    const generation = randomUUID();
    const libraryId = (await this.options.archive.identity()).instanceId;
    let committed = false;
    try {
      await this.options.archive.prepareAccountSubjects(subjects, generation);
      validate();
      const pending = { generation, libraryId, next };
      await this.write(this.active, pending);
      this.pending = pending;
      committed = true;
      accepted();
      this.options.changed();
      await this.recover();
    } catch (error) {
      if (!committed && !this.uncertain)
        try {
          await this.options.archive.discardAccountPreparation(generation);
        } catch (cleanup) {
          console.warn(
            'Account preparation cleanup deferred',
            cleanup instanceof Error ? cleanup.name : 'unknown',
          );
        }
      throw error;
    }
  }
  async update(value: T | null): Promise<void> {
    if (this.recovering) throw Error('ACCOUNT_ACTIVATION_PENDING');
    await this.write(value, null);
    this.active = value;
    this.options.changed();
  }
  async disconnect(): Promise<void> {
    // Publish an empty membership through the same durable acceptance protocol.
    // A restart after private acceptance resumes archiving before credentials clear.
    if (
      this.pending &&
      (await this.options.archive.identity()).instanceId !== this.pending.libraryId
    ) {
      await this.activate(
        [],
        null,
        () => undefined,
        () => undefined,
        true,
      );
      return;
    } else if (this.recovering) await this.recover();
    await this.activate(
      [],
      null,
      () => undefined,
      () => undefined,
    );
  }
}
