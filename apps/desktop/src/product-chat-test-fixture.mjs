import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as actualContext from '../chat/src/lib/agent-context.ts';

export function runner() {
  let serial = 0;
  let restored = [];
  const starts = [], sent = [], closed = [], history = new Map();
  let nextPrompt, nextStart, optionFailure = false;
  const bridge = {
    onEvent: () => () => {},
    start: async (agent, cwd, resume, meta) => {
      const key = 'native-' + ++serial;
      starts.push({ key, resume, meta });
      if (nextStart) { const pending = nextStart; nextStart = null; await pending; }
      history.set(key, []);
      return { ok: true, key, info: { sessionId: key, steering: true, configOptions: optionFailure ? [{ id: 'model', category: 'model', currentValue: 'old' }] : [] } };
    },
    prompt: async (key, text) => {
      const words = [...(history.get(key) ?? []), text];
      history.set(key, words);
      sent.push({ key, words });
      if (nextPrompt) { const pending = nextPrompt; nextPrompt = null; await pending; }
      return { ok: true, stopReason: 'end_turn' };
    },
    close: async key => { closed.push(key); return { ok: true }; },
    setOption: async () => { throw Error('option failed'); },
    ack: async () => ({ ok: true }),
    steer: async () => { throw Error('A product task must never steer'); },
    running: async () => restored,
  };
  const mocks = {
    react: { useSyncExternalStore: (_subscribe, snapshot) => snapshot() },
    './agent-context': actualContext,
    '@/lib/desktop-bridge': { desktopBridge: () => ({ localAgents: bridge }) },
    '@/lib/unprompted': { opensUnprompted: () => false },
    '@/lib/agent-transcript': { reduceTranscript: items => items },
    '../app-bridge': { app: {} },
    '@daocut/shared': {}, '@/lib/chat-store': {},
    'daocut/studio-ui/lib/storage-migration.ts': {},
  };
  const source = readFileSync(new URL('../chat/src/lib/local-agent-run.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled)(id => {
    if (!(id in mocks)) throw Error('Unmocked import ' + id);
    return mocks[id];
  }, module, module.exports);
  const api = module.exports;
  const run = (id, text, productStructure = false) => api.runLocalAgentTurn({
    projectId: 'project', conversation: 'visible-chat', agent: 'byok', cwd: '/synthetic', text,
    resume: 'previous-normal-session', turn: new api.LocalAgentTurn(id, 'byok'),
    meta: { turnId: id, projectId: 'project', sessionId: 'visible-chat', productStructure },
  });
  return { api, run, starts, sent, closed, hold: promise => { nextPrompt = promise; }, holdStart: promise => { nextStart = promise; }, failOption: () => { optionFailure = true; }, restore: value => { restored = value; } };
}

