/* eslint-disable @typescript-eslint/require-await -- Deterministic asynchronous persistence fixtures. */
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AccountActivation } from './account-activation.js';
import type { SubjectInput } from '../ports.js';

const credential = z.object({ cookiesText: z.string() }).strict();
const old = { cookiesText: 'private-old' },
  next = { cookiesText: 'private-next' };
const imported: SubjectInput[] = [{ id: 'stripchat:42', providerId: 42, handle: 'new-follow' }];
function fixture() {
  let sealed: string | null = JSON.stringify(old),
    marker: string | null = null;
  let following: SubjectInput[] = [];
  const preparations = new Map<string, SubjectInput[]>();
  const vault = {
    readSealedSecret: vi.fn(async () => sealed),
    writeSealedSecret: vi.fn(async (_purpose: 'account-sync', value: string | null) => {
      sealed = value;
    }),
  };
  const archive = {
    identity: vi.fn(async () => ({
      instanceId: '25c22e00-a0f9-4f62-a7fd-e8c4da4d717b',
      userId: 'fixture',
      timelineStartMs: 0,
    })),
    prepareAccountSubjects: vi.fn(async (subjects: SubjectInput[], id: string) => {
      preparations.set(id, subjects);
    }),
    activateAccountSubjects: vi.fn(async (id: string) => {
      if (marker === id) return;
      const rows = preparations.get(id);
      if (!rows) throw Error('ACCOUNT_PREPARATION_MISSING');
      following = rows;
      marker = id;
      preparations.delete(id);
    }),
    accountActivation: vi.fn(async () => marker),
    discardAccountPreparation: vi.fn(async (id: string) => {
      preparations.delete(id);
    }),
  };
  const create = async () => {
    const activation = new AccountActivation({
      archive,
      vault,
      parse: (value) => credential.parse(value),
      changed: () => undefined,
    });
    await activation.load();
    return activation;
  };
  return { archive, vault, create, saved: () => sealed, following: () => following };
}
it('does not publish follows when private acceptance fails and discards only unaccepted preparation', async () => {
  const f = fixture(),
    activation = await f.create();
  f.vault.writeSealedSecret.mockRejectedValueOnce(Error('PRIVATE_WRITE_FAILED'));
  const accepted = vi.fn();
  await expect(activation.activate(imported, next, () => undefined, accepted)).rejects.toThrow(
    'PRIVATE_WRITE_FAILED',
  );
  expect(f.following()).toEqual([]);
  expect(activation.active).toEqual(old);
  expect(accepted).not.toHaveBeenCalled();
  expect(f.archive.discardAccountPreparation).toHaveBeenCalledOnce();
});
it('recovers an accepted activation after the library fails without storing credentials in media', async () => {
  const f = fixture(),
    activation = await f.create();
  f.archive.activateAccountSubjects.mockRejectedValueOnce(Error('MEDIA_FAILED'));
  await expect(
    activation.activate(
      imported,
      next,
      () => undefined,
      () => undefined,
    ),
  ).rejects.toThrow('MEDIA_FAILED');
  expect(activation.recovering).toBe(true);
  expect(f.saved()).toContain('private-next');
  expect(JSON.stringify(f.archive.prepareAccountSubjects.mock.calls)).not.toContain('private-');
  expect(f.archive.discardAccountPreparation).not.toHaveBeenCalled();
  const restarted = await f.create();
  await restarted.recover();
  expect(restarted.active).toEqual(next);
  expect(f.following()).toEqual(imported);
  expect(restarted.recovering).toBe(false);
});
it('uses the published generation after a final private write failure instead of reapplying follows', async () => {
  const f = fixture(),
    activation = await f.create();
  const write = f.vault.writeSealedSecret.getMockImplementation()!;
  f.vault.writeSealedSecret
    .mockImplementationOnce(write)
    .mockRejectedValueOnce(Error('FINAL_WRITE_FAILED'));
  await expect(
    activation.activate(
      imported,
      next,
      () => undefined,
      () => undefined,
    ),
  ).rejects.toThrow('FINAL_WRITE_FAILED');
  expect(activation.active).toEqual(next);
  expect(f.following()).toEqual(imported);
  const restarted = await f.create();
  await restarted.recover();
  expect(f.archive.activateAccountSubjects).toHaveBeenCalledOnce();
  expect(restarted.active).toEqual(next);
  expect(restarted.recovering).toBe(false);
});
it('reconciles a lost private write acknowledgement before deciding acceptance', async () => {
  const f = fixture(),
    activation = await f.create();
  const write = f.vault.writeSealedSecret.getMockImplementation()!;
  f.vault.writeSealedSecret.mockImplementationOnce(async (...args) => {
    await write(...args);
    throw Error('LOST_REPLY');
  });
  const accepted = vi.fn();
  await activation.activate(imported, next, () => undefined, accepted);
  expect(accepted).toHaveBeenCalledOnce();
  expect(activation.active).toEqual(next);
  expect(f.archive.activateAccountSubjects).toHaveBeenCalledOnce();
});
it('retains uncertain preparation when private readback is unavailable and resumes from its real record', async () => {
  const f = fixture(),
    activation = await f.create();
  const write = f.vault.writeSealedSecret.getMockImplementation()!;
  f.vault.writeSealedSecret.mockImplementationOnce(async (...args) => {
    await write(...args);
    throw Error('LOST_REPLY');
  });
  f.vault.readSealedSecret.mockRejectedValueOnce(Error('PRIVATE_UNAVAILABLE'));
  await expect(
    activation.activate(
      imported,
      next,
      () => undefined,
      () => undefined,
    ),
  ).rejects.toThrow('LOST_REPLY');
  expect(activation.recovering).toBe(true);
  expect(f.archive.discardAccountPreparation).not.toHaveBeenCalled();
  await activation.recover();
  expect(f.following()).toEqual(imported);
  expect(activation.active).toEqual(next);
});
it('keeps the private pending record small regardless of imported list size', async () => {
  const f = fixture(),
    activation = await f.create();
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    id: `stripchat:${index + 1}`,
    providerId: index + 1,
    handle: 'public-list-name',
    previewSourceUrl: `https://images.invalid/${'x'.repeat(1024)}`,
  }));
  await activation.activate(
    rows,
    next,
    () => undefined,
    () => undefined,
  );
  const privateValues = f.vault.writeSealedSecret.mock.calls.map((call) => call[1]);
  expect(privateValues.every((value) => value !== null && value.length < 1024)).toBe(true);
  expect(JSON.stringify(privateValues)).not.toContain('public-list-name');
});
it('does not cross the acceptance point after cancellation of prepared public data', async () => {
  const f = fixture(),
    activation = await f.create();
  await expect(
    activation.activate(
      imported,
      next,
      () => {
        throw Error('CANCELLED');
      },
      () => undefined,
    ),
  ).rejects.toThrow('CANCELLED');
  expect(f.vault.writeSealedSecret).not.toHaveBeenCalled();
  expect(f.archive.activateAccountSubjects).not.toHaveBeenCalled();
  expect(f.archive.discardAccountPreparation).toHaveBeenCalledOnce();
});
it('does not apply another library pending activation and allows explicit disconnect', async () => {
  const f = fixture(),
    activation = await f.create();
  f.archive.activateAccountSubjects.mockRejectedValueOnce(Error('MEDIA_FAILED'));
  await expect(
    activation.activate(
      imported,
      next,
      () => undefined,
      () => undefined,
    ),
  ).rejects.toThrow('MEDIA_FAILED');
  f.archive.identity.mockResolvedValue({
    instanceId: '4d2786bd-9b19-40db-85b7-f72dbf3d38be',
    userId: 'other',
    timelineStartMs: 0,
  });
  const restarted = await f.create();
  f.archive.activateAccountSubjects.mockClear();
  await expect(restarted.recover()).rejects.toThrow('ACCOUNT_ACTIVATION_LIBRARY_MISMATCH');
  expect(f.archive.activateAccountSubjects).not.toHaveBeenCalled();
  await restarted.disconnect();
  expect(f.saved()).toBeNull();
  expect(restarted.recovering).toBe(false);
  expect(f.archive.discardAccountPreparation).not.toHaveBeenCalled();
});

it('recovers accepted disconnect membership after a crash before library activation', async () => {
  const f = fixture(),
    activation = await f.create();
  await activation.activate(
    imported,
    next,
    () => undefined,
    () => undefined,
  );
  f.archive.activateAccountSubjects.mockRejectedValueOnce(Error('MEDIA_UNAVAILABLE'));
  await expect(activation.disconnect()).rejects.toThrow('MEDIA_UNAVAILABLE');
  expect(f.following()).toEqual(imported);
  expect(f.saved()).toContain('"next":null');
  const restarted = await f.create();
  await restarted.recover();
  expect(f.following()).toEqual([]);
  expect(restarted.active).toBeNull();
  expect(f.saved()).toBeNull();
});
