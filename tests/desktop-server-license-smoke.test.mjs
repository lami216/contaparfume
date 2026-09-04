import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

test('desktop server smoke enforces the fresh-install license gate', async () => {
  const source = await readFile('scripts/desktop-test-server.mjs', 'utf8');

  assert.doesNotMatch(source, /throw new Error\(['"]defaults missing['"]\)/);
  assert.doesNotMatch(source, /api\/auth\/login|login cookie missing|12345678|المالك/);
  assert.match(source, /zero-user direct access: passed/);
  assert.match(source, /bootstrap[\s\S]*?402[\s\S]*?LICENSE_REQUIRED/);
  assert.match(source, /command[\s\S]*?402[\s\S]*?LICENSE_REQUIRED/);
  assert.match(source, /restart zero-user direct mode: passed/);
});
