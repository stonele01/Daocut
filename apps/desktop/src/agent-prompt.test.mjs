import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSTRUCTIONS, STUDIO_REFERENCES, ownAgentPrompt } from './agents.mjs';

const count = (text, part) => text.split(part).length - 1;

test("the own-key prompt includes the editing contract and Studio links without the full generic manual", () => {
  const prompt = ownAgentPrompt();
  assert.equal(count(prompt, '<manual>'), 0, 'full manual is available on demand, not injected by default');
  assert.ok(!prompt.includes('npx daocut'), 'the command on its PATH, as the manual reads for it');
  assert.ok(!prompt.includes(INSTRUCTIONS), 'not the words for another agent');
  assert.match(prompt, /read the installed manual with daocut/, 'special operations can still access the installed manual');
  assert.ok(!prompt.includes('## A page'), 'full page tutorial is not part of the default request');
  assert.equal(count(prompt, STUDIO_REFERENCES), 1, 'how Studio is pointed at, once');
  assert.equal(count(prompt, 'Reply in the language'), 1);
  assert.match(prompt, /Never run `daocut open`/, 'Studio is open beside it, whatever the manual says of `open`');
});

test('every agent is told how to point at Studio', () => {
  assert.ok(INSTRUCTIONS.endsWith(STUDIO_REFERENCES));
});

test('the SDK supplies task-matched skill discovery without a separate Daocut first-task gate', async () => {
  const { buildSystemPromptSections } = await import(new URL('./core/system-prompt.js', import.meta.resolve('@earendil-works/pi-coding-agent')));
  const prompt = ownAgentPrompt();
  assert.ok(!prompt.includes('daocut-live-commerce-editing'), 'no particular skill is a mandatory startup step');
  assert.ok(!prompt.includes('install/enable'), 'a missing skill does not impose an installation gate');
  const base = { customPrompt: prompt, cwd: 'D:/synthetic-project', selectedTools: ['read', 'bash', 'edit', 'write', 'ask'] };
  const skill = { name: 'synthetic-slicing', description: 'Editing a synthetic livestream', filePath: 'D:/synthetic-skills/slicing/SKILL.md' };
  const sections = buildSystemPromptSections({ ...base, skills: [skill] });
  assert.equal(sections.preamble, prompt, 'the SDK retains the business prompt');
  assert.match(sections.skills, /when the task matches its description/, 'native task-matched loading remains available');
  assert.match(sections.skills, /<location>D:\/synthetic-skills\/slicing\/SKILL.md<\/location>/);
  assert.equal(count(Object.values(sections).join('\n'), '<available_skills>'), 1, 'one catalog, without duplicating SDK instructions');
  for (const skills of [[], [{ ...skill, disableModelInvocation: true }]]) {
    const without = buildSystemPromptSections({ ...base, skills });
    assert.equal(without.preamble, prompt);
    assert.equal(without.skills, undefined, 'no visible skills leaves the ordinary prompt usable');
  }
});
