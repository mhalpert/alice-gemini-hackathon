import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_STRING_LEN,
  calllog,
  getCallLogPath,
  redactSecrets,
  sanitizeRoomName,
  sanitizeValue,
  startCallLog,
} from '../src/calllog.ts';
import { isBadEvent, runCli } from '../scripts/calllog.ts';

function withTempLogDir(fn: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'alice-calllog-'));
  const prev = process.env.ALICE_LOG_DIR;
  process.env.ALICE_LOG_DIR = dir;
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => {
      if (prev === undefined) {
        delete process.env.ALICE_LOG_DIR;
      } else {
        process.env.ALICE_LOG_DIR = prev;
      }
      rmSync(dir, { recursive: true, force: true });
    });
}

test('calllog writes JSON lines with t, ms, pid, ev, and extra data', async () => {
  await withTempLogDir((dir) => {
    calllog('room-alpha', 'shopper_joined', { identity: 'shopper-1', attrs: { camera: 'on' } });
    calllog('room-alpha', 'user_said', { text: 'hello' });

    const filePath = path.join(dir, 'room-alpha.jsonl');
    const lines = readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    assert.equal(lines.length, 2);
    assert.equal(typeof lines[0]!.t, 'string');
    assert.ok(!Number.isNaN(Date.parse(lines[0]!.t as string)));
    assert.equal(lines[0]!.ms, 0);
    assert.equal(lines[0]!.pid, process.pid);
    assert.equal(lines[0]!.ev, 'shopper_joined');
    assert.equal(lines[0]!.identity, 'shopper-1');
    assert.deepEqual(lines[0]!.attrs, { camera: 'on' });

    assert.equal(lines[1]!.ev, 'user_said');
    assert.equal(lines[1]!.text, 'hello');
    assert.ok(typeof lines[1]!.ms === 'number' && (lines[1]!.ms as number) >= 0);
  });
});

test('calllog reads first line timestamp from existing file for ms offset', async () => {
  await withTempLogDir((dir) => {
    const filePath = path.join(dir, 'existing-room.jsonl');
    const fiveSecondsAgo = new Date(Date.now() - 5000).toISOString();
    writeFileSync(
      filePath,
      `${JSON.stringify({ t: fiveSecondsAgo, ms: 0, pid: process.pid, ev: 'job_start' })}\n`,
      'utf8',
    );

    calllog('existing-room', 'session_started', { model: 'gemini-3.8-live' });
    const lines = readFileSync(filePath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    assert.equal(lines.length, 2);
    assert.ok((lines[1]!.ms as number) >= 4900, `expected ms >= 4900, got ${lines[1]!.ms}`);
  });
});

test('calllog truncates long strings (including nested) to 2000 chars and serializes Error objects', async () => {
  await withTempLogDir(() => {
    const huge = 'x'.repeat(5000);
    const err = new Error('boom ' + 'y'.repeat(3000));
    calllog('truncate-room', 'tool_error', {
      top: huge,
      nested: { deeper: [huge] },
      error: err,
    });

    const lines = readFileSync(getCallLogPath('truncate-room'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const entry = lines[0]!;
    assert.equal((entry.top as string).length, MAX_STRING_LEN);
    const nested = entry.nested as { deeper: string[] };
    assert.equal(nested.deeper[0]!.length, MAX_STRING_LEN);

    const errObj = entry.error as { message: string; stack?: string };
    assert.equal(errObj.message.length, MAX_STRING_LEN);
    assert.ok(errObj.message.startsWith('boom '));
    assert.equal(typeof errObj.stack, 'string');
    assert.ok((errObj.stack as string).length <= MAX_STRING_LEN);
  });
});

test('calllog never throws on circular refs, BigInt, throwing getters, or invalid log dir', async () => {
  await withTempLogDir(() => {
    const circular: Record<string, unknown> = { a: 1, big: 42n };
    circular.self = circular;
    Object.defineProperty(circular, 'badGetter', {
      enumerable: true,
      get() {
        throw new Error('getter exploded');
      },
    });

    assert.doesNotThrow(() => {
      calllog('safe-room', 'weird_data', circular);
    });

    const lines = readFileSync(getCallLogPath('safe-room'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines[0]!.self, '[Circular]');
    assert.equal(lines[0]!.big, '42');
    assert.equal(lines[0]!.badGetter, '[Unreadable]');

    // Point ALICE_LOG_DIR to a path under a regular file so mkdirSync fails.
    const filePath = getCallLogPath('safe-room');
    process.env.ALICE_LOG_DIR = path.join(filePath, 'impossible-subdir');
    assert.doesNotThrow(() => {
      calllog('safe-room', 'should_not_throw', { ok: true });
    });
  });
});

test('sanitizeRoomName removes path traversal and unsafe characters', () => {
  assert.equal(sanitizeRoomName('alice-room_01'), 'alice-room_01');
  assert.equal(sanitizeRoomName('../../etc/passwd'), 'etc_passwd');
  assert.equal(sanitizeRoomName('my room:with/slashes*'), 'my_room_with_slashes');
  assert.equal(sanitizeRoomName('...'), 'unknown');
  assert.equal(sanitizeRoomName(''), 'unknown');
});

test('startCallLog logs job_start and detects restart when file has a different pid', async () => {
  await withTempLogDir((dir) => {
    const first = startCallLog('fresh-room');
    assert.equal(first.restarted, false);

    const freshLines = readFileSync(path.join(dir, 'fresh-room.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(
      freshLines.map((l) => l.ev),
      ['job_start'],
    );

    const restartFile = path.join(dir, 'restarted-room.jsonl');
    const oldPid = process.pid + 99999;
    writeFileSync(
      restartFile,
      `${JSON.stringify({ t: new Date().toISOString(), ms: 0, pid: oldPid, ev: 'job_start' })}\n`,
      'utf8',
    );

    const second = startCallLog('restarted-room');
    assert.equal(second.restarted, true);
    assert.equal(second.prevPid, oldPid);

    const lines = readFileSync(restartFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.deepEqual(
      lines.map((l) => l.ev),
      ['job_start', 'job_start', 'restart'],
    );
    assert.equal(lines[2]!.prev_pid, oldPid);
  });
});

test('scripts/calllog.ts reader lists calls, filters states/errors, and prefixes bad lines with !!', async () => {
  await withTempLogDir((dir) => {
    calllog('call-1', 'job_start');
    calllog('call-1', 'agent_state', { state: 'listening' });
    calllog('call-1', 'user_state', { state: 'speaking' });
    calllog('call-1', 'tool_error', { name: 'build_outfits', error: new Error('timeout') });
    calllog('call-1', 'custom_ev', { error: 'something went wrong' });

    assert.equal(isBadEvent({ ev: 'restart' }), true);
    assert.equal(isBadEvent({ ev: 'false_interruption' }), true);
    assert.equal(isBadEvent({ ev: 'custom_ev', error: 'oops' }), true);
    assert.equal(isBadEvent({ ev: 'user_said', text: 'hi' }), false);

    const listed = runCli(['list'], dir);
    assert.equal(listed.exitCode, 0);
    assert.match(listed.output, /call-1/);

    const defaultView = runCli(['call-1'], dir);
    assert.equal(defaultView.exitCode, 0);
    assert.doesNotMatch(defaultView.output, /agent_state/);
    assert.doesNotMatch(defaultView.output, /user_state/);
    assert.match(defaultView.output, /^!! .*tool_error/m);
    assert.match(defaultView.output, /^!! .*custom_ev/m);

    const allView = runCli(['call-1', '--all'], dir);
    assert.match(allView.output, /agent_state/);
    assert.match(allView.output, /user_state/);

    const errorsView = runCli(['call-1', '--errors'], dir);
    assert.doesNotMatch(errorsView.output, /job_start/);
    assert.match(errorsView.output, /tool_error/);
    assert.match(errorsView.output, /custom_ev/);
  });
});

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(overrides)) {
    prev.set(k, process.env[k]);
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of prev.entries()) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

test('redactSecrets masks configured env vars (>= 12 chars), Google keys, query params, and JWTs', () => {
  const fakeEnv = {
    GOOGLE_API_KEY: 'fake-google-' + 'g'.repeat(12),
    GOOGLE_TRYON_API_KEY: 'fake-tryon-' + 't'.repeat(12),
    LIVEKIT_API_SECRET: 'fake-lk-sec-' + 's'.repeat(12),
    TAVUS_API_KEY: 'fake-tavus-' + 'k'.repeat(12),
    ALICE_PASSCODE: 'pass.[a-z]+$' + 'p'.repeat(6),
  };

  withEnv(fakeEnv, () => {
    for (const [name, val] of Object.entries(fakeEnv)) {
      const text = `first=${val} second=${val}`;
      assert.equal(redactSecrets(text), `first=[redacted:${name}] second=[redacted:${name}]`);
    }
  });

  // After env vars are restored, the same fake values (without key-like patterns) are not masked.
  assert.equal(redactSecrets(fakeEnv.TAVUS_API_KEY), fakeEnv.TAVUS_API_KEY);

  // Google-key shape
  const fakeGoogleKey = 'AIza' + 'x'.repeat(35);
  assert.equal(
    redactSecrets(`upstream failed with ${fakeGoogleKey} and ${fakeGoogleKey}`),
    'upstream failed with [redacted:google-key] and [redacted:google-key]',
  );

  // Key-bearing query parameters
  const qSecret = 'sec' + '9'.repeat(16);
  assert.equal(
    redactSecrets(`https://api.example.com/v1?key=${qSecret}&alt=json`),
    'https://api.example.com/v1?key=[redacted]&alt=json',
  );
  assert.equal(
    redactSecrets(`https://api.example.com/v1?foo=1&api_key=${qSecret}&bar=2`),
    'https://api.example.com/v1?foo=1&api_key=[redacted]&bar=2',
  );
  assert.equal(
    redactSecrets(`https://api.example.com/v1?APIKEY=${qSecret}`),
    'https://api.example.com/v1?APIKEY=[redacted]',
  );
  assert.equal(
    redactSecrets(`https://api.example.com/v1?access_token=${qSecret} "next"`),
    'https://api.example.com/v1?access_token=[redacted] "next"',
  );
  assert.equal(
    redactSecrets(`https://api.example.com/v1?room=r1&token=${qSecret}&v=1`),
    'https://api.example.com/v1?room=r1&token=[redacted]&v=1',
  );

  // JWT
  const fakeJwt = ['eyJ' + 'a'.repeat(14), 'eyJ' + 'b'.repeat(14), 'c'.repeat(16)].join('.');
  assert.equal(
    redactSecrets(`Authorization: Bearer ${fakeJwt}`),
    'Authorization: Bearer [redacted:jwt]',
  );
});

test('redactSecrets ignores env values shorter than 12 chars and masks 12+ char values', () => {
  const shortVal = 'pass' + '1'.repeat(7); // 11 chars
  assert.equal(shortVal.length, 11);
  withEnv({ ALICE_PASSCODE: shortVal }, () => {
    const msg = `entered ${shortVal} on screen`;
    assert.equal(redactSecrets(msg), msg);
  });

  const minVal = 'pass' + '2'.repeat(8); // 12 chars
  assert.equal(minVal.length, 12);
  withEnv({ ALICE_PASSCODE: minVal }, () => {
    const msg = `entered ${minVal} on screen`;
    assert.equal(redactSecrets(msg), 'entered [redacted:ALICE_PASSCODE] on screen');
  });
});

test('redactSecrets returns ordinary strings unchanged', () => {
  const samples = [
    'https://cdn.shopify.com/s/files/1/0000/1111/products/coat.jpg?v=123&width=600',
    '/tryon/tryon-abc123def456.jpg',
    'gid://shopify/ProductVariant/123',
    'alice-room_01',
    'The key insight is that the token budget stayed low.',
  ];
  for (const sample of samples) {
    assert.equal(redactSecrets(sample), sample);
  }
});

test('sanitizeValue masks secrets in nested objects, arrays, Error message, and Error stack while preserving keys', () => {
  const fakeGoogleKey = 'AIza' + 'z'.repeat(35);
  const fakeJwt = ['eyJ' + 'd'.repeat(12), 'eyJ' + 'e'.repeat(12), 'f'.repeat(12)].join('.');
  const err = new Error(`request failed: https://generativelanguage.googleapis.com/v1?key=${fakeGoogleKey}`);
  err.stack = `Error: ${fakeGoogleKey}\n    at fetch (https://example.com?token=${fakeJwt}:1:1)`;

  const sanitized = sanitizeValue({
    keyNameUnchanged: {
      deep: `key=${fakeGoogleKey}`,
      list: [fakeJwt, `https://example.com/x?api_key=${'k'.repeat(16)}&ok=1`],
    },
    err,
  }) as {
    keyNameUnchanged: { deep: string; list: string[] };
    err: { message: string; stack?: string };
  };

  assert.equal(sanitized.keyNameUnchanged.deep, 'key=[redacted:google-key]');
  assert.equal(sanitized.keyNameUnchanged.list[0], '[redacted:jwt]');
  assert.equal(sanitized.keyNameUnchanged.list[1], 'https://example.com/x?api_key=[redacted]&ok=1');
  assert.ok(!sanitized.err.message.includes('AIza'));
  assert.ok(sanitized.err.message.includes('?key=[redacted]'));
  assert.ok(sanitized.err.stack && !sanitized.err.stack.includes('AIza'));
  assert.ok(sanitized.err.stack && !sanitized.err.stack.includes('eyJ'));
});

test('calllog end-to-end leaves no AIza key in written JSONL file', async () => {
  await withTempLogDir(() => {
    const fakeGoogleKey = 'AIza' + 'm'.repeat(35);
    calllog('redact-e2e-room', 'upstream_error', {
      url: `https://generativelanguage.googleapis.com/v1beta/models?key=${fakeGoogleKey}`,
      error: new Error(`403 for ${fakeGoogleKey}`),
    });

    const raw = readFileSync(getCallLogPath('redact-e2e-room'), 'utf8');
    assert.ok(!raw.includes('AIza'), `expected no AIza in log file, got: ${raw}`);
    const parsed = JSON.parse(raw.trim()) as {
      url: string;
      error: { message: string; stack?: string };
    };
    assert.equal(parsed.url, 'https://generativelanguage.googleapis.com/v1beta/models?key=[redacted]');
    assert.equal(parsed.error.message, '403 for [redacted:google-key]');
  });
});

test('sanitizeValue handles a 5 MB string quickly and truncates to MAX_STRING_LEN', () => {
  const fakeGoogleKey = 'AIza' + 'q'.repeat(35);
  const big = `prefix ${fakeGoogleKey} ` + 'a'.repeat(5 * 1024 * 1024);

  const start = performance.now();
  const result = sanitizeValue(big) as string;
  const elapsedMs = performance.now() - start;

  assert.equal(result.length, MAX_STRING_LEN);
  assert.ok(result.startsWith('prefix [redacted:google-key] '));
  assert.ok(!result.includes('AIza'));
  assert.ok(elapsedMs < 500, `expected fast redaction of 5 MB string, took ${elapsedMs.toFixed(1)}ms`);
});
