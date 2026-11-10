import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedStructurePlanIds, toggleStructurePlan } from './structure-export-selection.ts';

test('only checked plans export, in public list order, across virtual rows and groups', () => {
  const plans = Array.from({ length: 256 }, (_, i) => ({ id: `plan-${i}` }));
  let selected = new Set<string>();
  assert.deepEqual(selectedStructurePlanIds(plans, selected), []);
  selected = toggleStructurePlan(selected, 'plan-255');
  selected = toggleStructurePlan(selected, 'plan-3');
  assert.deepEqual(selectedStructurePlanIds(plans, selected), ['plan-3', 'plan-255']);
  selected = toggleStructurePlan(selected, 'plan-3');
  assert.deepEqual(selectedStructurePlanIds(plans, selected), ['plan-255']);
  assert.deepEqual(selectedStructurePlanIds([{ id: 'other-scope' }], selected), []);
  assert.equal(selected.size, 1, 'reconciliation never selects other plans implicitly');
});
