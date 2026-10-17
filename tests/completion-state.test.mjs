import test from 'node:test';
import assert from 'node:assert/strict';
import { allTasksCompleted, updateCompletionState } from '../electron/core/completion-state.ts';

test('tracks ordinary and magnet completion transitions once', () => {
  const previous = new Map();
  const ordinary = { id: 'http-1', fileName: 'a.zip', directory: 'C:/Downloads', status: 'downloading', kind: 'ordinary' };
  const magnet = { id: 'magnet-1', fileName: 'b.iso', directory: 'C:/Downloads', status: 'paused', kind: 'magnet' };
  let state = updateCompletionState([ordinary], [magnet], previous);
  assert.equal(state.newlyCompleted.length, 0);
  assert.equal(state.allCompleted, false);
  state = updateCompletionState([{ ...ordinary, status: 'completed' }], [magnet], previous);
  assert.deepEqual(state.newlyCompleted.map(task => task.id), ['http-1']);
  state = updateCompletionState([{ ...ordinary, status: 'completed' }], [{ ...magnet, status: 'completed' }], previous);
  assert.deepEqual(state.newlyCompleted.map(task => task.id), ['magnet-1']);
  assert.equal(state.allCompleted, true);
  state = updateCompletionState([{ ...ordinary, status: 'completed' }], [{ ...magnet, status: 'completed' }], previous);
  assert.equal(state.newlyCompleted.length, 0);
});

test('does not trigger all-complete actions for an empty task list', () => {
  assert.equal(allTasksCompleted([], []), false);
});
