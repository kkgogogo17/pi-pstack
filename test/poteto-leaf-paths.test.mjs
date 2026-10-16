import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, copyFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolve, join } from 'node:path';

const potetoDir = fileURLToPath(new URL('../skills/poteto-mode/', import.meta.url));
const skill = readFileSync(resolve(potetoDir, 'SKILL.md'), 'utf8');
const script = fileURLToPath(new URL('../scripts/resolve-principle.mjs', import.meta.url));
const run = (path, name, cwd) => spawnSync(process.execPath, [path, name], { cwd, encoding: 'utf8' });

test('poteto mode gives a resolvable path for every principle leaf', () => {
  assert.ok(skill.includes('leaf skills live at `../principle-*/SKILL.md`'), 'sibling leaf path guidance is missing');
  const principles = [...skill.matchAll(/\(\*\*(principle-[\w-]+)\*\*\)/g)].map((match) => match[1]);
  assert.ok(principles.length >= 20, 'principle entries were found');
  for (const principle of principles) {
    const leaf = resolve(potetoDir, '..', principle, 'SKILL.md');
    assert.ok(existsSync(leaf), `${principle} must resolve to ${leaf}`);
    const result = run(script, principle, potetoDir);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, `${leaf}\n`);
  }
});

test('a guessed nested principle path cannot resolve as a leaf', () => {
  const result = run(script, 'poteto-mode/principle-foundational-thinking', potetoDir);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Invalid principle name/);
});

test('resolves a sibling leaf from any working directory', () => {
  const result = run(script, 'principle-foundational-thinking', tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${resolve(potetoDir, '../principle-foundational-thinking/SKILL.md')}\n`);
  assert.equal(result.stderr, '');
});

test('rejects missing leaves, traversal, and extra arguments without stdout', () => {
  for (const [args, message] of [
    [['principle-not-present'], /Principle skill not found/],
    [['../principle-foundational-thinking'], /Invalid principle name/],
    [['principle-foundational-thinking/../principle-boundary-discipline'], /Invalid principle name/],
    [['principle-foundational-thinking', 'principle-boundary-discipline'], /Invalid principle name/],
  ]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, message);
  }
});

test('resolves from an installed package layout, not the caller directory', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pstack-leaf-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const installed = join(root, 'node_modules/pi-pstack');
  mkdirSync(join(installed, 'scripts'), { recursive: true });
  mkdirSync(join(installed, 'skills/principle-foundational-thinking'), { recursive: true });
  copyFileSync(script, join(installed, 'scripts/resolve-principle.mjs'));
  copyFileSync(resolve(potetoDir, '../principle-foundational-thinking/SKILL.md'), join(installed, 'skills/principle-foundational-thinking/SKILL.md'));
  const result = run(join(installed, 'scripts/resolve-principle.mjs'), 'principle-foundational-thinking', root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${join(installed, 'skills/principle-foundational-thinking/SKILL.md')}\n`);
  assert.equal(result.stderr, '');
  mkdirSync(join(installed, 'skills/principle-not-a-file/SKILL.md'), { recursive: true });
  const directory = run(join(installed, 'scripts/resolve-principle.mjs'), 'principle-not-a-file', root);
  assert.notEqual(directory.status, 0);
  assert.equal(directory.stdout, '');
  assert.match(directory.stderr, /Principle skill not found/);
  mkdirSync(join(installed, 'skills/principle-escaped'), { recursive: true });
  symlinkSync(join(installed, 'scripts/resolve-principle.mjs'), join(installed, 'skills/principle-escaped/SKILL.md'));
  const escaped = run(join(installed, 'scripts/resolve-principle.mjs'), 'principle-escaped', root);
  assert.notEqual(escaped.status, 0);
  assert.equal(escaped.stdout, '');
  assert.match(escaped.stderr, /Principle skill not found/);
  assert.ok(JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).files.includes('scripts'));
});
