import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'typebox']) {
  test(`${name} is installed as a test dependency, not only a consumer peer`, () => {
    assert.ok(packageJson.peerDependencies[name]);
    assert.ok(packageJson.devDependencies?.[name], `${name} must be available to local node --test`);
  });
}

test('test dependencies have a reproducible lockfile', () => {
  const lock = JSON.parse(readFileSync(new URL('../../package-lock.json', import.meta.url), 'utf8'));
  assert.deepEqual(lock.packages[''].devDependencies, packageJson.devDependencies);
});
