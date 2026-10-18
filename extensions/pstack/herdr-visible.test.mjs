import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import registerPstack, { runChildVisible } from './index.ts';

const agent = {
  name: 'poteto-agent', description: 'Test agent', systemPrompt: 'Return a result.',
  source: 'bundled', filePath: 'test.md',
};
const task = { agent: 'poteto-agent', task: 'Return the verified result.' };

test('the direct Node test command has installable Pi peer packages', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  for (const name of ['@earendil-works/pi-ai', '@earendil-works/pi-coding-agent', 'typebox']) {
    assert.ok(pkg.devDependencies?.[name], `${name} is required by the direct test import`);
  }
});

function fixture(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'pstack-herdr-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  const session = path.join(root, 'session.jsonl');
  writeFileSync(session, options.STALE_ANSWER ? JSON.stringify({ type: 'message', message: {
    role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'stale result' }],
  } }) + '\n' : '');
  const log = path.join(root, 'calls.jsonl');
  writeFileSync(log, '');
  writeFileSync(path.join(bin, 'herdr'), `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(args) + '\\n');
let result = { accepted: true };
if (args[0] === 'pane' && args[1] === 'current') result = { pane: { pane_id: process.env.HERDR_TEST_PARENT_MISMATCH ? 'w9:p3' : 'w9:p1', terminal_id: 'parent-terminal' } };
const calls = readFileSync(process.env.HERDR_TEST_LOG, 'utf8').trim().split('\\n').map(JSON.parse);
const starts = calls.filter(x => x[0] === 'agent' && x[1] === 'start');
const ownStart = starts.find(x => x[2] === args[2]);
if (args[0] === 'pane' && args[1] === 'split') {
  const splits = calls.filter(x => x[0] === 'pane' && x[1] === 'split').length;
  result = { pane: { pane_id: process.env.HERDR_TEST_PARALLEL ? 'w9:p' + (splits + 1) : 'w9:p2' } };
}
if (args[0] === 'agent' && args[1] === 'start') {
  const promptFile = args[args.indexOf('--append-system-prompt') + 1];
  if (promptFile) appendFileSync(process.env.HERDR_TEST_LOG, JSON.stringify(['system-prompt', readFileSync(promptFile, 'utf8')]) + '\\n');
  const sessionPath = args[args.indexOf('--session') + 1];
  if (sessionPath) require('node:fs').writeFileSync(sessionPath, readFileSync(process.env.HERDR_TEST_SESSION));
  if (process.env.HERDR_TEST_START_UNCERTAIN) {
    process.stderr.write('start response unavailable');
    process.exit(1);
  }
  result = { agent: { agent_status: 'idle' } };
}
if (args[0] === 'agent' && args[1] === 'get') {
  const gets = calls.filter(x => x[0] === 'agent' && x[1] === 'get' && x[2] === args[2]).length;
  const pane = ownStart?.[ownStart.indexOf('--pane') + 1] || 'w9:p2';
  result = { agent: { pane_id: pane, terminal_id: gets > 1 && process.env.HERDR_TEST_REPLACEMENT ? 'replacement' : 'terminal-' + pane, agent_status: gets > 1 ? (process.env.HERDR_TEST_STATUS || 'idle') : 'idle', state_change_seq: gets > 1 ? 4 : 1 } };
}
if (args[0] === 'agent' && args[1] === 'prompt' && process.env.HERDR_TEST_PROMPT_DELAY) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.HERDR_TEST_PROMPT_DELAY));
}
if (args[0] === 'agent' && args[1] === 'prompt' && process.env.HERDR_TEST_PROMPT_FAIL) {
  process.stderr.write('timeout: submission outcome unknown');
  process.exit(1);
}
if (args[0] === 'agent' && args[1] === 'prompt' && !process.env.HERDR_TEST_EMPTY_SESSION) {
  const sessionPath = ownStart[ownStart.indexOf('--session') + 1];
  const answer = process.env.HERDR_TEST_PARALLEL ? args[3].split('Delegated task:\\n').at(-1).trim() : 'verified result';
  appendFileSync(sessionPath, JSON.stringify({ type: 'message', message: {
    role: 'assistant', stopReason: process.env.HERDR_TEST_TOOL_ONLY ? 'toolUse' : 'stop',
    content: [{ type: 'text', text: answer }],
  } }) + '\\n');
}
if (args[0] === 'agent' && args[1] === 'read') {
  process.stdout.write('Pi is idle.\\n> Prompt');
  process.exit(0);
}
if (args[0] === 'pane' && args[1] === 'process-info') result = { process_info: { foreground_processes: [{ name: process.env.HERDR_TEST_FOREGROUND || 'pi' }] } };
if (args[0] === 'pane' && args[1] === 'close' && process.env.HERDR_TEST_CLOSE_FAIL) {
  process.stderr.write('close response unavailable');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ result }));
`, { mode: 0o755 });
  const old = {
    PATH: process.env.PATH, HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_TEST_LOG: process.env.HERDR_TEST_LOG,
    HERDR_TEST_SESSION: process.env.HERDR_TEST_SESSION, HERDR_TEST_STATUS: process.env.HERDR_TEST_STATUS,
    HERDR_TEST_FOREGROUND: process.env.HERDR_TEST_FOREGROUND,
    HERDR_TEST_PROMPT_FAIL: process.env.HERDR_TEST_PROMPT_FAIL,
    HERDR_TEST_REPLACEMENT: process.env.HERDR_TEST_REPLACEMENT,
    HERDR_TEST_PROMPT_DELAY: process.env.HERDR_TEST_PROMPT_DELAY,
    HERDR_TEST_CLOSE_FAIL: process.env.HERDR_TEST_CLOSE_FAIL,
    HERDR_TEST_EMPTY_SESSION: process.env.HERDR_TEST_EMPTY_SESSION,
    HERDR_TEST_PARENT_MISMATCH: process.env.HERDR_TEST_PARENT_MISMATCH,
    HERDR_TEST_STALE_ANSWER: process.env.HERDR_TEST_STALE_ANSWER,
    HERDR_TEST_START_UNCERTAIN: process.env.HERDR_TEST_START_UNCERTAIN,
    HERDR_TEST_TOOL_ONLY: process.env.HERDR_TEST_TOOL_ONLY,
    HERDR_TEST_PARALLEL: process.env.HERDR_TEST_PARALLEL,
  };
  process.env.HERDR_PANE_ID = 'w9:p1';
  process.env.PATH = `${bin}:${old.PATH}`;
  process.env.HERDR_ENV = '1';
  process.env.HERDR_TEST_LOG = log;
  process.env.HERDR_TEST_SESSION = session;
  for (const [key, value] of Object.entries(options)) process.env[`HERDR_TEST_${key}`] = value;
  return {
    calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse),
    recordCall: (args) => appendFileSync(log, JSON.stringify(args) + '\n'),
    cleanup() {
      for (const start of this.calls().filter(([group, action]) => group === 'agent' && action === 'start')) {
        const index = start.indexOf('--session');
        const sessionPath = index < 0 ? undefined : start[index + 1];
        if (!sessionPath) continue;
        const directory = path.dirname(sessionPath);
        if (path.basename(sessionPath) === 'session.jsonl' && path.dirname(directory) === tmpdir() &&
          path.basename(directory).startsWith('pi-pstack-agent-')) {
          rmSync(directory, { recursive: true, force: true });
        }
      }
      for (const [key, value] of Object.entries(old)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('fixture cleanup ignores start calls without a verified session path', () => {
  const env = fixture();
  env.recordCall(['agent', 'start', 'orphan']);
  assert.doesNotThrow(() => env.cleanup());
});

function tool() {
  const registered = new Map();
  registerPstack({
    on() {}, registerCommand() {}, registerTool(definition) { registered.set(definition.name, definition); },
  });
  return registered.get('subagent');
}

const ctx = { cwd: tmpdir(), model: undefined, hasUI: false };

test('successful visible subagent result closes its owned pane', async () => {
  const env = fixture();
  try {
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 0);
    assert.equal(result.answer, 'verified result');
    assert.deepEqual(result.messages, []);
    const closes = env.calls().filter(([group, action]) => group === 'pane' && action === 'close');
    assert.deepEqual(closes, [['pane', 'close', 'w9:p2']]);
    assert.match(env.calls().find(([group, action]) => group === 'agent' && action === 'start')[2], /^psub-/);
    const prompt = env.calls().find(([group, action]) => group === 'agent' && action === 'prompt');
    assert.match(prompt[3], /Parent Herdr pane ID: w9:p1/);
    assert.doesNotMatch(prompt[3], /Return a result\./);
    const start = env.calls().find(([group, action]) => group === 'agent' && action === 'start');
    assert.ok(start.includes('--no-extensions'));
    assert.ok(start.includes('--session'));
    const promptFile = start[start.indexOf('--append-system-prompt') + 1];
    assert.ok(promptFile.endsWith('/poteto-agent.md'));
    assert.match(env.calls().find(([kind]) => kind === 'system-prompt')[1], /Return a result\./);
    assert.deepEqual(env.calls().find(([group, action]) => group === 'pane' && action === 'current'),
      ['pane', 'current', '--current']);
  } finally {
    env.cleanup();
  }
});

test('a changed caller pane identity blocks delegation before splitting a child', async () => {
  const env = fixture({ PARENT_MISMATCH: '1' });
  try {
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /parent pane identity/);
    assert.equal(env.calls().some(([group, action]) => group === 'pane' && action === 'split'), false);
  } finally {
    env.cleanup();
  }
});

test('a missing caller pane ID blocks delegation before splitting a child', async () => {
  const env = fixture();
  try {
    delete process.env.HERDR_PANE_ID;
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /parent pane identity/);
    assert.equal(env.calls().some(([group, action]) => group === 'pane' && action === 'split'), false);
  } finally {
    env.cleanup();
  }
});

test('uncertain prompt failure preserves its child pane and reports the pane ID', async () => {
  const env = fixture({ PROMPT_FAIL: '1' });
  try {
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /w9:p2/);
    assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close'), []);
  } finally {
    env.cleanup();
  }
});

test('blocked agent is not reported as a completed subagent or closed', async () => {
  const env = fixture({ STATUS: 'blocked' });
  try {
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /w9:p2/);
    assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close'), []);
  } finally {
    env.cleanup();
  }
});

test('replaced agent identity prevents closing the pane', async () => {
  const env = fixture({ REPLACEMENT: '1' });
  try {
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close'), []);
  } finally {
    env.cleanup();
  }
});

test('foreground work preserves the pane and reports deferred cleanup with the result', async () => {
  const env = fixture({ FOREGROUND: 'bash' });
  try {
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.pane, { kind: 'left-open', id: 'w9:p2', reason: 'foreground process is not only Pi' });
    assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close'), []);
  } finally {
    env.cleanup();
  }
});

test('the registered subagent tool returns a result for each mode and closes its pane', async () => {
  for (const [params, mode] of [
    [{ agent: 'poteto-agent', task: 'Reply.' }, 'single'],
    [{ tasks: [{ agent: 'poteto-agent', task: 'Reply.' }] }, 'parallel'],
    [{ chain: [{ agent: 'poteto-agent', task: 'Reply.' }] }, 'chain'],
  ]) {
    const env = fixture();
    try {
      const result = await tool().execute('test', params, undefined, undefined, ctx);
      assert.equal(result.details.mode, mode);
      assert.equal(result.details.results[0].pane.kind, 'closed');
      assert.match(result.content[0].text, /verified result/);
      assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close'),
        [['pane', 'close', 'w9:p2']]);
    } finally {
      env.cleanup();
    }
  }
});

test('parallel children close only their own panes and retain separate answers', async () => {
  const env = fixture({ PARALLEL: '1' });
  try {
    const result = await tool().execute('test', { tasks: [
      { agent: 'poteto-agent', task: 'First child.' },
      { agent: 'poteto-agent', task: 'Second child.' },
    ] }, undefined, undefined, ctx);
    assert.equal(result.details.mode, 'parallel');
    assert.deepEqual(result.details.results.map(child => child.pane).sort((a, b) => a.id.localeCompare(b.id)), [
      { kind: 'closed', id: 'w9:p2' }, { kind: 'closed', id: 'w9:p3' },
    ]);
    assert.deepEqual(result.details.results.map(child => child.answer), ['First child.', 'Second child.']);
    assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close')
      .map(([, , pane]) => pane).sort(), ['w9:p2', 'w9:p3']);
    const prompts = env.calls().filter(([group, action]) => group === 'agent' && action === 'prompt');
    assert.equal(prompts.length, 2);
    for (const prompt of prompts) assert.match(prompt[3], /Parent Herdr pane ID: w9:p1/);
  } finally {
    env.cleanup();
  }
});

test('the registered subagent tool reports the pane when a completed result cannot be closed', async () => {
  const env = fixture({ FOREGROUND: 'bash' });
  try {
    const result = await tool().execute('test', { agent: 'poteto-agent', task: 'Reply.' }, undefined, undefined, ctx);
    assert.match(result.content[0].text, /Pane w9:p2: foreground process is not only Pi; left-open/);
    assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close'), []);
  } finally {
    env.cleanup();
  }
});

test('abort during a submitted prompt leaves the child pane and does not claim a result', async () => {
  const env = fixture({ PROMPT_DELAY: '150' });
  const controller = new AbortController();
  try {
    const pending = runChildVisible(agent, task, undefined, tmpdir(), controller.signal);
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /w9:p2/);
    assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close'), []);
  } finally {
    env.cleanup();
  }
});

test('stale assistant text and idle terminal output do not count as a new answer', async () => {
  const env = fixture({ EMPTY_SESSION: '1', STALE_ANSWER: '1' });
  try {
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /no completed result/);
    assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close'), []);
  } finally {
    env.cleanup();
  }
});

test('a tool-use assistant message is not a completed answer', async () => {
  const env = fixture({ TOOL_ONLY: '1' });
  try {
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /no completed result/);
    assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close'), []);
  } finally {
    env.cleanup();
  }
});

test('uncertain start is not retried and leaves its pane open', async () => {
  const env = fixture({ START_UNCERTAIN: '1' });
  try {
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /w9:p2/);
    assert.equal(env.calls().filter(([group, action]) => group === 'agent' && action === 'start').length, 1);
    assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close'), []);
  } finally {
    env.cleanup();
  }
});

test('an empty session is not a completed result and does not close the child', async () => {
  const env = fixture({ EMPTY_SESSION: '1' });
  try {
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 1);
    assert.match(result.stderr, /no completed result/);
    assert.deepEqual(env.calls().filter(([group, action]) => group === 'pane' && action === 'close'), []);
  } finally {
    env.cleanup();
  }
});

test('an unconfirmed close is surfaced without retrying a possibly applied close', async () => {
  const env = fixture({ CLOSE_FAIL: '1' });
  try {
    const result = await runChildVisible(agent, task, undefined, tmpdir(), undefined);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.pane, { kind: 'uncertain', id: 'w9:p2', reason: 'pane close was not confirmed' });
    assert.equal(env.calls().filter(([group, action]) => group === 'pane' && action === 'close').length, 1);
  } finally {
    env.cleanup();
  }
});
