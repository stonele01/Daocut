import { test } from 'node:test';
import assert from 'node:assert/strict';
import { displayStructureTag, displayStructureTags, hasStructureTag, productStructureTags } from './product-structure-tags.ts';
import { structureColor } from './structure-colors.ts';

test('new tag filters retain legacy price and purchase candidates without rewriting saved labels', () => {
  const candidates = [
    { id: 'old-price', tags: ['价格锚点'] },
    { id: 'new-offer', tags: ['福利机制'] },
    { id: 'old-purchase', tags: ['行动指令'] },
    { id: 'new-purchase', tags: ['逼单'] },
    { id: 'core', tags: ['卖点'] },
  ];
  const before = JSON.stringify(candidates);
  assert.deepEqual(candidates.filter(candidate => hasStructureTag(candidate.tags, '福利机制')).map(candidate => candidate.id), ['old-price', 'new-offer']);
  assert.deepEqual(candidates.filter(candidate => hasStructureTag(candidate.tags, '价格锚点')).map(candidate => candidate.id), ['old-price', 'new-offer']);
  assert.deepEqual(candidates.filter(candidate => hasStructureTag(candidate.tags, '逼单')).map(candidate => candidate.id), ['old-purchase', 'new-purchase']);
  assert.deepEqual(candidates.filter(candidate => hasStructureTag(candidate.tags, '行动指令')).map(candidate => candidate.id), ['old-purchase', 'new-purchase']);
  assert.equal(candidates.filter(candidate => hasStructureTag(candidate.tags, '全部')).length, candidates.length);
  assert.equal(JSON.stringify(candidates), before);
});

test('display aliases are deduplicated while new content roles and unknown historical tags remain readable', () => {
  assert.deepEqual(displayStructureTags(['价格锚点', '福利机制', '行动指令', '逼单', '故事', '信任背书', '自定义标签']), ['福利机制', '逼单', '故事', '信任背书', '自定义标签']);
  assert.equal(displayStructureTag('价格锚点'), '福利机制');
  for (const tag of ['故事', '痛点', '卖点', '产品演示', '福利机制', '信任背书', '逼单']) assert.ok(productStructureTags.includes(tag));
  assert.ok(!productStructureTags.includes('价格锚点'));
  assert.ok(!productStructureTags.includes('行动指令'));
  assert.deepEqual(structureColor('价格锚点'), structureColor('福利机制'));
  assert.deepEqual(structureColor('行动指令'), structureColor('逼单'));
  assert.notDeepEqual(structureColor('故事'), structureColor('unknown'));
  assert.notDeepEqual(structureColor('信任背书'), structureColor('unknown'));
});
