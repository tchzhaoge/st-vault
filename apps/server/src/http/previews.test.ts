import Fastify from 'fastify';
import { describe, it, expect, vi } from 'vitest';
import type { PreviewsPort } from '../ports.js';
import { registerPreviews } from './previews.js';
import { previewImageType } from '../previews/image-type.js';
import { PreviewError } from '../previews/index.js';

describe('cover raster response format', () => {
  it('serves cached avatars with the same raster validation and ETag contract, and represents missing portraits without a broken image', async () => {
    let available = false;
    const bytes = new Uint8Array([255, 216, 255, 217]);
    const avatar = vi.fn(() =>
      available ? Promise.resolve(bytes) : Promise.reject(new PreviewError('preview_not_found')),
    );
    const app = Fastify();
    registerPreviews(app, {
      avatar,
      cover: () => Promise.resolve(bytes),
      snapshot: () => Promise.resolve(bytes),
      snapshotPoint: () => Promise.resolve(null),
      close: () => Promise.resolve(),
    });
    try {
      expect((await app.inject('/api/subjects/stripchat:42/avatar.jpg')).statusCode).toBe(204);
      available = true;
      const first = await app.inject('/api/subjects/stripchat:42/avatar.jpg');
      expect(first.statusCode).toBe(200);
      expect(first.headers['content-type']).toBe('image/jpeg');
      const same = await app.inject({
        url: '/api/subjects/stripchat:42/avatar.jpg',
        headers: { 'if-none-match': first.headers.etag! },
      });
      expect(same.statusCode).toBe(304);
      expect(same.rawPayload).toHaveLength(0);
      expect(same.headers['cache-control']).toBe('private, no-cache');
    } finally {
      await app.close();
    }
  });
  it('keeps an unfinished background image retryable instead of reporting it as missing media', async () => {
    const previews: PreviewsPort = {
      cover: () => Promise.resolve(new Uint8Array()),
      snapshot: () => Promise.reject(new PreviewError('preview_pending')),
      snapshotPoint: () => Promise.resolve(null),
      close: () => Promise.resolve(),
    };
    const app = Fastify();
    registerPreviews(app, previews);
    try {
      const response = await app.inject('/api/subjects/stripchat:42/snapshots/60000.jpg?to=61000');
      expect(response.statusCode).toBe(202);
      expect(response.headers['retry-after']).toBe('1');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.json()).toEqual({ pending: true });
    } finally {
      await app.close();
    }
  });
  it('validates and delegates bounded snapshot page requests', async () => {
    const pages = vi.fn(() =>
      Promise.resolve({
        subjectId: 'stripchat:42',
        session: null,
        deletionRevision: 1,
        total: 0,
        page: 1,
        pages: 0,
        occupiedPages: [],
        limit: 30,
        items: [],
      }),
    );
    const previews: PreviewsPort = {
      cover: () => Promise.resolve(new Uint8Array()),
      snapshot: () => Promise.resolve(new Uint8Array()),
      snapshotPoint: () => Promise.resolve(null),
      snapshotPages: pages,
      close: () => Promise.resolve(),
    };
    const app = Fastify();
    registerPreviews(app, previews);
    try {
      const page = await app.inject(
        '/api/subjects/stripchat:42/snapshot-pages?at=1000&from=0&to=60000',
      );
      expect(page.statusCode).toBe(200);
      expect(
        (await app.inject('/api/subjects/stripchat:42/snapshot-samples?from=0&to=60000'))
          .statusCode,
      ).toBe(404);
      expect(page.headers['cache-control']).toBe('private, no-store');
      expect(pages).toHaveBeenCalledWith(
        'stripchat:42',
        1000,
        1,
        30,
        expect.any(AbortSignal),
        {
          fromMs: 0,
          toMs: 60000,
        },
        false,
        undefined,
      );
      for (const query of [
        'snapshot-pages?at=1&from=0&to=60000&limit=100001',
        'snapshot-pages?at=1&page=0',
        'snapshot-pages?at=1&from=0',
        'snapshot-pages?at=1&from=100&to=100',
        'snapshot-pages?at=1&from=0&to=864000000',
        'snapshot-samples?from=0&to=604800001',
        'snapshot-samples?from=0&to=60000&count=17',
      ])
        expect((await app.inject(`/api/subjects/stripchat:42/${query}`)).statusCode).not.toBe(200);
      expect(pages).toHaveBeenCalledTimes(1);
      expect(
        (
          await app.inject(
            '/api/subjects/stripchat:42/snapshot-pages?at=1000&from=0&to=60000&limit=60',
          )
        ).statusCode,
      ).toBe(200);
      expect(pages).toHaveBeenLastCalledWith(
        'stripchat:42',
        1000,
        1,
        60,
        expect.any(AbortSignal),
        {
          fromMs: 0,
          toMs: 60000,
        },
        false,
        undefined,
      );
      const unitId = '00000000-0000-4000-8000-000000000042';
      expect(
        (
          await app.inject(
            `/api/subjects/stripchat:42/snapshot-pages?at=1000&from=0&to=60000&unitId=${unitId}`,
          )
        ).statusCode,
      ).toBe(200);
      expect(pages.mock.calls.at(-1)?.at(-1)).toBe(unitId);
    } finally {
      await app.close();
    }
  });
  it('serves detected JPEG/PNG/WebP with matching MIME and never labels a WebP response JPEG', async () => {
    const images: [Uint8Array, string][] = [
      [Buffer.from([255, 216, 255, 217]), 'image/jpeg'],
      [
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
          'base64',
        ),
        'image/png',
      ],
      [Buffer.from('5249464610000000574542505650384c0400000000000000', 'hex'), 'image/webp'],
    ];
    let bytes = images[0][0];
    const previews: PreviewsPort = {
      cover: () => Promise.resolve(bytes),
      snapshot: () => Promise.resolve(images[0][0]),
      snapshotPoint: () => Promise.resolve(null),
      close: () => Promise.resolve(),
    };
    const app = Fastify();
    registerPreviews(app, previews);
    try {
      for (const [image, type] of images) {
        bytes = image;
        const response = await app.inject('/api/subjects/stripchat:42/cover.jpg');
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toBe(type);
        expect(response.headers['cache-control']).toBe('private, no-cache');
        expect(response.rawPayload).toEqual(Buffer.from(image));
        const unchanged = await app.inject({
          url: '/api/subjects/stripchat:42/cover.jpg',
          headers: { 'if-none-match': response.headers.etag! },
        });
        expect(unchanged.statusCode).toBe(304);
        expect(unchanged.rawPayload.length).toBe(0);
        expect(unchanged.headers['cache-control']).toBe('private, no-cache');
      }
      const shot = await app.inject('/api/subjects/stripchat:42/snapshots/60000.jpg');
      expect(shot.headers['content-type']).toBe('image/jpeg');
    } finally {
      await app.close();
    }
  });
  it('rejects unknown/truncated raster signatures instead of trusting a MIME or filename', () => {
    for (const bytes of [
      Buffer.from('<svg/>'),
      Buffer.from('WEBP'),
      Buffer.from('5249464611000000574542505650384c0400000000000000', 'hex'),
    ])
      expect(previewImageType(bytes)).toBeNull();
  });
});
