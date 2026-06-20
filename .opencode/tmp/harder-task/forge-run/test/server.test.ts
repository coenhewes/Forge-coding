import { test } from 'node:test';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import * as path from 'node:path';

const SERVER_ENTRY = path.resolve(__dirname, '..', 'dist', 'index.js');

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function sendRequests(cp: ChildProcessWithoutNullStreams, payloads: object[]): void {
  // Write all requests in one burst, without awaiting any response.
  for (const p of payloads) {
    cp.stdin.write(JSON.stringify(p) + '\n');
  }
}

test('pipelined requests are answered in order and shutdown waits for them', async () => {
  const cp = spawn(process.execPath, [SERVER_ENTRY], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Suppress noisy child stderr but keep the stream alive.
  cp.stderr.on('data', () => {});

  const responses: JsonRpcResponse[] = [];
  let buf = '';
  cp.stdout.on('data', (chunk: Buffer) => {
    buf += chunk.toString('utf8');
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        responses.push(JSON.parse(line) as JsonRpcResponse);
      } catch {
        // ignore non-JSON lines
      }
    }
  });

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'noop', arguments: {} } },
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'run_command_safe',
      params: { command: 'echo hi' },
    },
    { jsonrpc: '2.0', id: 5, method: 'shutdown', params: {} },
  ];

  sendRequests(cp, requests);

  // Wait for the child process to exit naturally after processing all requests.
  const [exitCode] = (await once(cp, 'exit')) as [number | null];
  await once(cp.stdout, 'end').catch(() => {});

  // We must have received exactly one response per request, in id order.
  assert.equal(
    responses.length,
    5,
    `expected 5 responses, got ${responses.length}: ${JSON.stringify(responses)}`,
  );

  for (let i = 0; i < 5; i++) {
    assert.equal(responses[i].id, i + 1, `response[${i}].id should be ${i + 1}`);
    assert.equal(responses[i].jsonrpc, '2.0');
  }

  // All ids 1..5 must have arrived before the process exited.
  const seenIds = new Set(responses.map((r) => r.id));
  for (let id = 1; id <= 5; id++) {
    assert.ok(seenIds.has(id), `missing response for id ${id}`);
  }

  // Process must exit cleanly (0) after shutdown.
  assert.equal(exitCode, 0, `expected exit code 0, got ${exitCode}`);
});
