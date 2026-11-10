import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { promptReferenceToken, splitPromptReferenceText } from '../../../packages/shared/src/prompt-reference.ts';
import { buildMentionMenu } from '../chat/src/components/prompt-editor/mention-menu.ts';
import { zhCN } from '../chat/src/i18n/locales/zh-CN.ts';

const guardSource = readFileSync(new URL('../chat/src/lib/compact-command.ts', import.meta.url), 'utf8');
const guardCode = ts.transpileModule(guardSource, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const guardModule = { exports: {} };
new Function('require', 'module', 'exports', guardCode)((id) => {
  assert.equal(id, '@daocut/shared');
  return { splitPromptReferenceText };
}, guardModule, guardModule.exports);
const { compactPromptBlocker } = guardModule.exports;

const blocker = (text, extra = {}) => compactPromptBlocker({ agent: 'byok', text, attachmentCount: 0, active: false, ...extra });

test('compact accepts a standalone idle command and preserves ordinary messages and other agents', () => {
  assert.equal(blocker('  /compact \n'), null);
  assert.equal(blocker('/compact', { active: true }), 'composer.compactBusy');
  for (const text of ['hello', 'explain /compact', '/compactness', '/compact/foo']) {
    assert.equal(blocker(text, { active: true, attachmentCount: 1 }), null, text);
  }
  assert.equal(blocker('/compact keep the goal', { agent: 'codex', active: true, attachmentCount: 1 }), null);
});

test('attachments and every pill kind must be removed before compact; no command arguments are sent as a prompt', () => {
  assert.equal(blocker('/compact', { attachmentCount: 1 }), 'composer.compactStandalone');
  assert.equal(blocker('/compact keep this part'), 'composer.compactStandalone');
  for (const id of ['file:film.html', 'skill:edit-film', 'time:10', 'clip:one']) {
    const pill = promptReferenceToken(id);
    for (const text of ['/compact ' + pill, '/compact' + pill, pill + ' /compact']) {
      assert.equal(blocker(text), 'composer.compactStandalone', text);
    }
  }
});

const source = readFileSync(new URL('../chat/src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let submit;
let commandMenu;
const find = (node) => {
  if (ts.isFunctionDeclaration(node) && node.name?.text === 'submitFollowUp') submit = node.getText(ast);
  if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'commandMenu') commandMenu = node.initializer.getText(ast);
  ts.forEachChild(node, find);
};
find(ast);
assert.ok(submit, 'exercise the actual composer submit handler');
const handlerSource = ts.transpileModule(submit, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const translate = (key) => key.split('.').reduce((value, part) => value?.[part], zhCN);

function submitDraft({ text = '/compact', active = false, attachments = [], agent = 'byok' } = {}) {
  const calls = [];
  const draft = { text, attachments };
  const scope = {
    followUpFilled: true, followUp: draft.text, agent, active,
    queued: false, queuedProductRange: { current: null }, productRange: null, followUpRefs: [],
    composerFiles: { files: draft.attachments, take: () => { calls.push('take'); return draft.attachments.splice(0); } },
    compactPromptBlocker, t: translate,
    setQueued: (value) => calls.push(['queued', value]),
    setFollowUpError: (value) => calls.push(['error', value]),
    asset: { id: 'turn:active' },
    canSteer: () => { calls.push('steer-check'); return false; },
    composerRef: { current: { clear: () => { calls.push('clear'); draft.text = ''; } } },
    steerTurn: () => calls.push('steer'), runTurn: () => calls.push('run'),
  };
  const handler = new Function(...Object.keys(scope), handlerSource + '\nreturn submitFollowUp;')(...Object.values(scope));
  handler();
  return { draft, calls };
}

test('real composer handler keeps busy compact drafts, explains retry, and never queues or steers', () => {
  const { draft, calls } = submitDraft({ active: true });
  assert.equal(draft.text, '/compact');
  assert.deepEqual(calls, [['queued', false], ['error', zhCN.composer.compactBusy]]);
});

test('real composer handler keeps attachments and skill/reference drafts untouched', () => {
  for (const text of ['/compact', '/compact ' + promptReferenceToken('skill:edit-film'), '/compact ' + promptReferenceToken('file:film.html')]) {
    const attachments = text === '/compact' ? [{ id: 'attachment', state: 'ready' }] : [];
    const expected = structuredClone(attachments);
    const { draft, calls } = submitDraft({ text, attachments });
    assert.equal(draft.text, text);
    assert.deepEqual(draft.attachments, expected);
    assert.deepEqual(calls, [['queued', false], ['error', zhCN.composer.compactStandalone]]);
  }
  assert.deepEqual(submitDraft({ text: 'continue editing', active: true }).calls, ['steer-check', ['queued', true]], 'ordinary busy prompts retain the existing path');
});

test('bundled compact is available before a BYOK session and ACP advertisements never duplicate it', () => {
  const source = readFileSync(new URL('../chat/src/lib/local-agent-run.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  const react = { useSyncExternalStore: (_subscribe, snapshot) => snapshot() };
  new Function('require', 'module', 'exports', compiled)((id) => id === 'react' ? react : {}, module, module.exports);
  const api = module.exports;
  const first = api.useAgentCommands('byok');
  assert.equal(first.filter((c) => c.name === 'compact').length, 1);
  assert.equal(api.useAgentCommands('byok'), first, 'external-store snapshots stay stable');
  assert.deepEqual(api.useAgentCommands('codex'), [], 'other agents do not acquire unsupported commands');
  api.keepCommands('byok', []);
  assert.equal(api.useAgentCommands('byok')[0].name, 'compact');
  const advertised = { name: 'compact', description: 'native description', hint: null };
  api.keepCommands('byok', [advertised, { name: 'other', description: '', hint: null }]);
  assert.deepEqual(api.useAgentCommands('byok'), [advertised, { name: 'other', description: '', hint: null }]);
});

test('localized compact menu is searchable by Chinese label and the exact slash command', () => {
  assert.ok(commandMenu, 'exercise the actual App menu provider');
  const compiled = ts.transpileModule('function buildCommandMenu() { return ' + commandMenu + '; }', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const scope = {
    React: { useMemo: (build) => build() }, agent: 'byok',
    agentCommands: [{ name: 'compact', description: 'native description', hint: null }],
    nameableSkills: Array.from({ length: 25 }, (_, i) => ({ name: 'skill-' + i })),
    hiddenSkills: new Set(['compact']), skillPill: () => null, skillWords: (name) => ({ title: name }),
    skillReferenceId: (name) => 'skill:' + name, Blocks: () => null,
    t: translate, SquareSlash: () => null,
  };
  const { providers } = new Function(...Object.keys(scope), compiled + '\nreturn buildCommandMenu();')(...Object.values(scope));
  for (const query of ['', 'compact', '压缩']) {
    const entries = buildMentionMenu(providers, query);
    assert.equal(entries.length, query ? 1 : 20);
    assert.equal(entries[0].item.label, '压缩上下文');
    assert.deepEqual(entries[0].item.select(), { text: '/compact' });
  }
});
