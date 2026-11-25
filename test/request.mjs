import assert from 'node:assert/strict';
import { requestWithRetry } from '../src/extract/request.js';

async function run(statuses) {
  const calls = [];
  const waits = [];
  const response = await requestWithRetry(
    async () => {
      const status = statuses[calls.length];
      calls.push(status);
      return { status };
    },
    async (delay) => waits.push(delay)
  );
  return { response, calls, waits };
}

assert.deepEqual(await run([500, 503, 200]), {
  response: { status: 200 }, calls: [500, 503, 200], waits: [500, 1500],
});
assert.deepEqual(await run([500, 500, 500]), {
  response: { status: 500 }, calls: [500, 500, 500], waits: [500, 1500],
});
assert.deepEqual(await run([401]), {
  response: { status: 401 }, calls: [401], waits: [],
});
assert.deepEqual(await run([500, 403]), {
  response: { status: 403 }, calls: [500, 403], waits: [500],
});
console.log('ok - transient server errors are retried with bounded delays');
