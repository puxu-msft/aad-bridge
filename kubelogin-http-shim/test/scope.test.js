'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { getScope, serverIDFromScope } = require('../lib/scope');

const AKS = '6dae42f8-4368-4678-94ff-3960e28e3630';

test('getScope appends /.default to a bare server id', () => {
  assert.equal(getScope(AKS), `${AKS}/.default`);
});

test('getScope trims trailing slashes before appending', () => {
  assert.equal(getScope(`${AKS}/`), `${AKS}/.default`);
  assert.equal(getScope(`${AKS}///`), `${AKS}/.default`);
});

test('getScope leaves an already-suffixed scope untouched', () => {
  assert.equal(getScope(`${AKS}/.default`), `${AKS}/.default`);
});

test('serverIDFromScope strips the /.default suffix', () => {
  assert.equal(serverIDFromScope(`${AKS}/.default`), AKS);
  assert.equal(serverIDFromScope(AKS), AKS);
});
