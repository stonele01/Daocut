import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as motion from 'motion/react';
import ts from 'typescript';
import * as context from '../chat/src/lib/agent-context.ts';
import { enUS } from '../chat/src/i18n/locales/en-US.ts';
import { zhCN } from '../chat/src/i18n/locales/zh-CN.ts';
import { ja } from '../chat/src/i18n/locales/ja.ts';
import { ko } from '../chat/src/i18n/locales/ko.ts';
import { es } from '../chat/src/i18n/locales/es.ts';

const tables = { en: enUS, 'zh-CN': zhCN, ja, ko, es };
let language = 'zh-CN';
const word = (key) => key.split('.').reduce((value, part) => value?.[part], tables[language]);
const source = readFileSync(new URL('../chat/src/components/AgentContextIndicator.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React,
  esModuleInterop: true,
} }).outputText;
const imports = {
  react: React, 'motion/react': motion,
  '@/i18n': { useT: () => word, useUiLocale: () => language },
  '@/lib/agent-context': context,
  './Popover': { Popover: ({ trigger, open, children }) => React.createElement('div', null, trigger, open ? children : null) },
  './Tooltip': { Tooltip: ({ children }) => children },
};
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled)((id) => {
  if (!(id in imports)) throw Error('Unmocked import ' + id);
  return imports[id];
}, module, module.exports);
const { AgentContextDetails, AgentContextIndicator } = module.exports;
const html = (value) => renderToStaticMarkup(React.createElement(AgentContextDetails, { context: value }));
const snapshot = {
  used: 36000, size: 1000000,
  breakdown: { source: 'local-estimate', system: 1400, tools: 7400, messages: 23100 },
};

test('context details retain the agent total and label independent categories as estimates', () => {
  const content = html(snapshot);
  for (const text of ['~36K / 1M', '~1.4K', '~7.4K', '~23.1K', '系统提示词', '工具定义', '对话消息', '可能与总量不同', '工具结果和图片']) {
    assert.ok(content.includes(text), text);
  }
  assert.ok(!content.includes('~31.9K /'), 'category sum must not replace the native current-context total');
  assert.ok(!content.includes('费用') && !content.includes('CNY'), 'no billing claim');
});

test('external agents without categories show their total without invented category zeros', () => {
  const content = html({ used: 24000, size: 128000 });
  assert.ok(content.includes('~24K / 128K'));
  assert.ok(content.includes('暂未提供分项用量'));
  assert.ok(!content.includes('系统提示词') && !content.includes('工具定义') && !content.includes('对话消息'));
});

test('unknown context does not look empty; actual reported zero remains valid', () => {
  const unknown = html(null);
  assert.ok(unknown.includes('尚未报告'));
  assert.ok(!unknown.includes('0%') && !unknown.includes('~0'));
  assert.ok(html({ used: 0, size: 128000 }).includes('~0 / 128K'));
  const indicator = renderToStaticMarkup(React.createElement(AgentContextIndicator, { context: null }));
  assert.ok(indicator.includes('<button') && indicator.includes('aria-haspopup="dialog"'));
  assert.ok(indicator.includes('>—</span>'));
});

test('all supported locales provide the complete context-detail vocabulary', () => {
  for (const locale of Object.keys(tables)) {
    language = locale;
    for (const key of Object.keys(enUS.context)) assert.equal(typeof word('context.' + key), 'string', locale + ': ' + key);
    assert.ok(!html(snapshot).includes('context.'));
  }
  language = 'zh-CN';
});
