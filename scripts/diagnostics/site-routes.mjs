// Explicit public-network check, separate from the offline browser fixture.
import assert from 'node:assert/strict';
import {
  SiteRoutes,
  PUBLIC_SITE_ORIGINS,
} from '../../build/apps/server/src/provider/site-routes.js';
import { broadcastResponse } from '../../build/apps/server/src/provider/public-api.js';
if (process.env.STV_QA_PUBLIC_NETWORK !== '1') throw Error('PUBLIC_NETWORK_CHECK_NOT_ENABLED');
const bootstrap = new SiteRoutes();
let routes;
try {
  const id = await bootstrap.read('/api/front/models?limit=8&offset=0&primaryTag=girls', (text) => {
    const body = JSON.parse(text);
    const model = body.models?.find(
      (model) => model.isLive && model.status === 'public' && Number.isSafeInteger(model.id),
    );
    if (!model) throw Error('NO_PUBLIC_TEST_SUBJECT');
    return model.id;
  });
  const blocked = new Set(PUBLIC_SITE_ORIGINS.slice(0, 2));
  const calls = [];
  routes = new SiteRoutes({
    fetch: (input, init) => {
      const origin = new URL(String(input)).origin;
      calls.push(origin);
      assert.equal(new Headers(init?.headers).has('cookie'), false);
      assert.equal(new Headers(init?.headers).has('authorization'), false);
      assert.equal(init?.credentials, 'omit');
      return blocked.has(origin)
        ? Promise.reject(new TypeError('Synthetic unreachable origin'))
        : fetch(input, init);
    },
  });
  const started = performance.now();
  const item = await routes.read(`/api/front/v2/broadcasts/${id}`, (text) =>
    broadcastResponse(text, id),
  );
  const firstMs = Math.round(performance.now() - started);
  assert.equal(item.modelId, id);
  const selected = routes.status().selectedOrigin;
  assert(selected && !blocked.has(selected));
  const before = calls.length;
  await routes.read(`/api/front/v2/broadcasts/${id}`, (text) => broadcastResponse(text, id));
  assert.deepEqual(calls.slice(before), [selected]);
  console.log(
    JSON.stringify({
      check: 'public-site-failover',
      passed: true,
      syntheticBlockedOrigins: [...blocked],
      selectedOrigin: selected,
      firstMs,
      sameModelId: true,
      stickyReuse: true,
      credentialsSent: false,
    }),
  );
} finally {
  bootstrap.close();
  routes?.close();
}
