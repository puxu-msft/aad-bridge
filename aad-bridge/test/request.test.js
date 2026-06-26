'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseTokenRequest, resourceFromFields } = require('../lib/request');
const { fakeReq } = require('./helpers');

const AKS = '6dae42f8-4368-4678-94ff-3960e28e3630';

test('resourceFromFields prefers serverId', () => {
  assert.equal(resourceFromFields({ serverId: AKS, scope: 'other/.default' }), AKS);
});

test('resourceFromFields derives from scope, stripping /.default and trailing slash', () => {
  assert.equal(resourceFromFields({ scope: `${AKS}/.default` }), AKS);
  assert.equal(resourceFromFields({ scope: `${AKS}/` }), AKS);
  assert.equal(resourceFromFields({ scope: `${AKS}/.default extra/.default` }), AKS); // first token
  assert.equal(resourceFromFields({}), '');
});

test('parseTokenRequest GET reads query params', async () => {
  const req = fakeReq({ method: 'GET', url: `/token?scope=${AKS}%2F.default&tenantId=t1&serverId=${AKS}&subscription=sub1` });
  const out = await parseTokenRequest(req);
  assert.equal(out.resource, AKS);
  assert.equal(out.tenant, 't1');
  assert.equal(out.subscription, 'sub1');
});

test('parseTokenRequest GET derives resource from scope alone', async () => {
  const req = fakeReq({ method: 'GET', url: `/token?scope=${AKS}%2F.default` });
  const out = await parseTokenRequest(req);
  assert.equal(out.resource, AKS);
});

test('parseTokenRequest POST reads JSON body', async () => {
  const req = fakeReq({ method: 'POST', body: JSON.stringify({ serverId: AKS, tenantId: 't2', subscription: 's2' }) });
  const out = await parseTokenRequest(req);
  assert.equal(out.resource, AKS);
  assert.equal(out.tenant, 't2');
  assert.equal(out.subscription, 's2');
});

test('parseTokenRequest POST rejects invalid JSON', async () => {
  const req = fakeReq({ method: 'POST', body: '{not json' });
  await assert.rejects(() => parseTokenRequest(req), /invalid JSON/);
});
