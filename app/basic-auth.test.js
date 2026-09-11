import assert from 'node:assert/strict';
import test from 'node:test';
import { basicAuthorization, isBasicAuthorized } from './basic-auth.js';

test('basic authentication validates both fields', () => {
  const header = basicAuthorization('viewer', 'test-password');
  assert.equal(isBasicAuthorized(header, 'viewer', 'test-password'), true);
  assert.equal(isBasicAuthorized(header, 'viewer', 'wrong'), false);
  assert.equal(isBasicAuthorized(header, 'other', 'test-password'), false);
  assert.equal(isBasicAuthorized('', 'viewer', 'test-password'), false);
});
