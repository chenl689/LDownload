import test from 'node:test';
import assert from 'node:assert/strict';
import { createThrottledPublisher } from '../electron/core/throttled-publisher.ts';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

test('coalesces frequent progress callbacks into one bounded update', async () => {
  let updates = 0;
  const publisher = createThrottledPublisher(() => { updates++; }, 40);

  publisher.schedule();
  publisher.schedule();
  publisher.schedule();
  assert.equal(updates, 0);

  await wait(55);
  assert.equal(updates, 1);
  publisher.cancel();
});

test('flushes one pending progress update immediately and cancels its timer', async () => {
  let updates = 0;
  const publisher = createThrottledPublisher(() => { updates++; }, 80);

  publisher.schedule();
  publisher.flush();
  assert.equal(updates, 1);

  await wait(100);
  assert.equal(updates, 1);
});
