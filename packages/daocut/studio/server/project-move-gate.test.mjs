import test from 'node:test';
import assert from 'node:assert/strict';
import { createProjectMoveGate } from './project-move-gate.mjs';

test('a move cannot overlap a pending save, and a move blocks later saves and reads until released', () => {
  const gate = createProjectMoveGate();
  const save = gate.enter('a', 'write');
  assert.throws(() => gate.enter('a', 'move'), error => error.status === 409);
  save();
  const moved = gate.enter('a', 'move');
  assert.throws(() => gate.enter('a', 'write'), error => error.status === 409);
  assert.throws(() => gate.enter('a', 'read'), error => error.status === 409);
  assert.throws(() => gate.enter('a', 'move'), error => error.status === 409);
  const other = gate.enter('b', 'write'); other();
  moved(); moved();
  const next = gate.enter('a', 'write'); next();
  gate.enter('a', 'move')();
});

test('ordinary reads and writes keep existing concurrency, without acquiring a lasting move lock', () => {
  const gate = createProjectMoveGate();
  const read = gate.enter('a', 'read'), first = gate.enter('a', 'write'), second = gate.enter('a', 'write');
  first(); assert.throws(() => gate.enter('a', 'move'), error => error.status === 409);
  read(); second(); gate.enter('a', 'move')();
});
