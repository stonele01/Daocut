import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listSkills, parseSkillFile } from './skills.mjs';

const SKILLS = join(import.meta.dirname, '..', 'skills');
const NAMES = readdirSync(SKILLS, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

test('every official skill: a SKILL.md named as its folder, with a description, and a title and summary in five languages', () => {
  assert.ok(NAMES.length > 0);
  for (const name of NAMES) {
    const { fields } = parseSkillFile(readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8'));
    assert.equal(fields.name, name);
    assert.ok(fields.description.trim().length > 0, `${name} says when to use it`);
    const shown = JSON.parse(readFileSync(join(SKILLS, name, 'daocut.json'), 'utf8'));
    assert.equal(shown.repository, name === 'daocut-live-commerce-editing' ? 'https://github.com/stonele01/Daocut' : `https://github.com/stonele01/Daocut/tree/main/packages/daocut/skills/${name}`);
    for (const lang of ['en', 'zh-CN', 'ja', 'ko', 'es']) {
      assert.ok(shown.title[lang], `${name} title ${lang}`);
      assert.ok(shown.summary[lang], `${name} summary ${lang}`);
    }
  }
});

test('every file a skill names in its own folder is there', () => {
  for (const name of NAMES) {
    const md = readFileSync(join(SKILLS, name, 'SKILL.md'), 'utf8');
    for (const [, file] of md.matchAll(/<this skill's folder>\/([\w.-]+)/g)) {
      assert.ok(existsSync(join(SKILLS, name, file)), `${name} names ${file}`);
    }
  }
});

test('Daocut discovery publishes slicing, video replication and premium motion graphics', () => {
  const catalog = listSkills({ official: SKILLS, mine: join(SKILLS, '.no-personal-skills') });
  assert.deepEqual(catalog.map((skill) => skill.name), ['daocut-live-commerce-editing', 'motion-graphics', 'replicate']);
  assert.equal(catalog.find((skill) => skill.name === 'replicate').shown.title['zh-CN'], '视频复刻');
});
