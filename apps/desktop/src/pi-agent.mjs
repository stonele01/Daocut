import { brandEnv } from 'daocut/brand-env';
/**
 * The app's own agent: Pi (`@earendil-works/pi-coding-agent`, MIT) run through its SDK, in a process of its own,
 * speaking ACP on stdin/stdout like the person's Codex and Claude Code adapters do, so the chat takes it the same way
 * (agents.mjs starts it with Electron as Node).
 *
 * What it runs with comes in DAOCUT_PI (JSON; pi-config.mjs): its own folder (`agentDir`: Pi's models and settings,
 * never the person's ~/.pi), the person's models (`models`, each its own service with its key in a variable, its name,
 * the model asked for and its reasoning efforts: pi-config.mjs OwnModel; `model` the id of the one a session starts
 * on; the chat switches between them with the session's `model` option, and a model's efforts with `effort`, for one
 * offering more than one; `auto` sends none), and its whole system prompt (agents.mjs ownAgentPrompt), in place of Pi's. Of the project's instructions only its own AGENTS.md (or CLAUDE.md) is read, not
 * the folders above it; no SYSTEM.md; of skills only Daocut's (`skills`: their folder and names, agent-skills.mjs). Besides Pi's read, bash, edit and write it has `ask`: questions for
 * the person, with options, shown in the chat as Claude Code's and Codex's are (an ACP form).
 *
 * A conversation's session is kept with the project it is about (chat-store.mjs: `.film/chat/agent/`), so it goes
 * where the project goes. Each prompt may name, in `_meta.daocut`, the turn's log: each request to the model (its whole
 * context, as Pi sends it, and the answer) is written there (chat-store.mjs's `<turn>.model.jsonl`), only what is new
 * since the request before.
 *
 * Pictures are kept within the model services' size limits (pi-config.mjs): a request carries those of the latest
 * KEEP_PICTURE_RESULTS tool results that hold one, and at most IMAGE_BUDGET of them, the oldest left out of the request
 * first (never out of the session). A service refusing a request as too large (HTTP 413, a proxy's page included) is
 * tried again once with half of those pictures, as Pi tries a busy one; that half stays the conversation's limit. A
 * request with no pictures in it is not tried again: its own words are too large, and the turn says so.
 *
 * What Pi does goes to the chat as ACP session updates: its words and thinking as they stream, each tool call (its
 * kind, title and input) and its result, after each answer how full the context is, and a model service tried again.
 */
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, estimateTokens } from '@earendil-works/pi-coding-agent';
import { install, setGlobalDispatcher } from 'undici';
import { agentSessionsDir, openLog } from './chat-store.mjs';
import { createModelDispatcher, networkFetch } from './pi-network.mjs';
import { modelPricing } from './model-usage.mjs';
import { quotaStream } from './pi-quota.mjs';
import { compactionEvidenceExtension, installCompactionRecovery } from './pi-compaction.mjs';
import { askTool } from './pi-ask.mjs';
import { turnToolPolicy } from './pi-turn-intent.mjs';
import { IMAGE_BUDGET, THINKING, TOO_LARGE, WAIT_MINUTES, sessionContextUpdate, effortOption, fitImages, modelOption, modelsJson, providerOf, retryNotice, stopReason, toolCall, toolContent } from './pi-config.mjs';

/* stdout is the protocol's: anything else Pi or a library prints goes to stderr */
console.log = console.info = console.warn = console.debug = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`);

/* some services think quietly for minutes before they answer: wait that long for a byte (Node's fetch stops at 5
   minutes), with fetch and its connections from one undici, as Pi's own command line sets them */
const WAIT_MS = WAIT_MINUTES * 60_000;
setGlobalDispatcher(createModelDispatcher(WAIT_MS));
install();

const config = JSON.parse(brandEnv('PI') ?? '{}');
/** Daocut's skills for this session (agent-skills.mjs): Pi loads these and no others */
const ownSkills = { paths: Array.isArray(config.skills?.paths) ? config.skills.paths : [], names: Array.isArray(config.skills?.names) ? config.skills.names : [] };
const VERSION = '1.1.0';
/** @type {import('./pi-config.mjs').OwnModel[]} */
const models = Array.isArray(config.models) ? config.models : [];
const byId = new Map(models.map((m) => [m.id, m]));
const startModel = byId.has(config.model) ? config.model : models[0]?.id;

/** Extra focus for Pi's native checkpoint, not a replacement prompt or permission to continue work. */
const COMPACTION_INSTRUCTIONS = `Preserve the user's current goal and acceptance criteria; all explicit constraints,
preferences and authorization boundaries; confirmed decisions and their reasons; exact asset paths, timecodes and
project identifiers needed to continue; completed work and validation results; current project progress, unresolved
issues, pending user questions and the next tasks in order. Distinguish confirmed facts from assumptions and proposed
work from approved work. Keep the latest corrections and do not revive cancelled tasks or broaden authorization.
Use the conversation's language. Summarize only: do not carry out tasks or continue the edit.`;

/** Only the standalone slash command is local; prose, arguments and attached content remain ordinary prompts. */
function isCompactionCommand(blocks) {
  return Array.isArray(blocks) && blocks.length === 1 && blocks[0]?.type === 'text'
    && typeof blocks[0].text === 'string' && blocks[0].text.trim() === '/compact';
}

mkdirSync(config.agentDir, { recursive: true });
const modelsPath = join(config.agentDir, 'models.json');
writeFileSync(modelsPath, JSON.stringify(modelsJson(models), null, 2));
const modelRuntime = await ModelRuntime.create({ authPath: join(config.agentDir, 'auth.json'), modelsPath });

/** Each open session: Pi's, the turn being logged, and its model (the id) and effort as the chat names them. */
const sessions = new Map();

/** Pi's model for one of the person's and an effort: its service as itself for `auto` (no reasoning setting), else thinking. */
function piModel(/** @type {string} */ id, /** @type {string} */ effort) {
  const own = byId.get(id);
  const model = own && modelRuntime.getModel(effort === 'auto' ? providerOf(id) : THINKING(providerOf(id)), own.model);
  if (!model) throw new Error(`No model ${own?.name ?? id}.`);
  return model;
}

/** Which of the person's models Pi's model is (a conversation taken up again names its provider), and whether thinking. */
function ownOf(/** @type {any} */ piModelNow) {
  const provider = String(piModelNow?.provider ?? '');
  const thinking = models.some((m) => provider === THINKING(providerOf(m.id)));
  const own = models.find((m) => provider === providerOf(m.id) || provider === THINKING(providerOf(m.id)));
  return { id: own?.id ?? null, thinking };
}

/** The session's options: the model, and its effort when it offers more than one. */
const optionsOf = (/** @type {{ model: string, effort: string }} */ entry) =>
  [modelOption(models, entry.model), effortOption(byId.get(entry.model)?.levels ?? ['auto'], entry.effort)].filter(Boolean);

/** Put a session on a model and an effort. */
async function use(/** @type {any} */ entry, /** @type {string} */ model, /** @type {string} */ effort) {
  await entry.session.setModel(piModel(model, effort));
  if (effort !== 'auto') entry.session.setThinkingLevel(effort);
  entry.model = model;
  entry.effort = effort;
  entry.sendContext?.();
}

/** The model log of a turn: each request's context and its answer, only what is new since the last request. */
function modelLog(cwd, turnId) {
  const file = openLog(cwd, turnId, (e) => process.stderr.write(`model log: ${e.message}\n`), '.model');
  let keys = [];
  let system = 'null';
  let tools = 'null';
  return {
    write({ startedAt, messages, toolsNow, answer, pricing, quotaRequestId }) {
      const all = messages.map((m) => JSON.stringify(m));
      let prefix = 0;
      while (prefix < keys.length && prefix < all.length && keys[prefix] === all[prefix]) prefix += 1;
      const toolsKey = JSON.stringify(toolsNow);
      const systemKey = JSON.stringify(answer?.systemPrompt ?? null);
      file.write('call', {
        startedAt, ms: Date.now() - startedAt, prefix, messages: messages.slice(prefix),
        ...(toolsKey !== tools ? { tools: toolsNow } : {}), ...(systemKey !== system ? { systemPrompt: answer?.systemPrompt ?? null } : {}),
        answer: answer?.message ?? null, pricing: modelPricing(pricing),
        ...(quotaRequestId ? { quotaRequestId } : {}),
      });
      keys = all;
      tools = toolsKey;
      system = systemKey;
    },
    networkError: (failure) => file.write('network_error', failure),
    end: () => file.end(),
  };
}

async function open(client, cwd, resumeId) {
  const sessionDir = agentSessionsDir(cwd);
  const file = resumeId ? SessionManager.findById(cwd, resumeId, sessionDir) : null;
  if (resumeId && !file) throw new Error('That conversation is not here any more.');
  const sessionManager = file ? SessionManager.open(file, sessionDir) : SessionManager.create(cwd, sessionDir);
  /* the model clients' own timeout too (WAIT_MS above), then one more try */
  const settingsManager = SettingsManager.inMemory({ httpIdleTimeoutMs: WAIT_MS, retry: { enabled: true, maxRetries: 1 } });
  /* the request about to go: its whole context, for the turn's log */
  let pending = null;
  /* the session's id, once it has one: the questions `ask` puts are the session's */
  let sessionId = null;
  /* the pictures a request carries at most (pi-config.mjs IMAGE_BUDGET), and those the last one carried (bytes) */
  let imageBudget = IMAGE_BUDGET;
  let imagesSent = 0;
  const resourceLoader = new DefaultResourceLoader({
    cwd, agentDir: config.agentDir, settingsManager, noExtensions: true, noPromptTemplates: true, noThemes: true,
    /* Daocut's skills, and no other Pi would find (in the project, or its own folders) */
    noSkills: !ownSkills.names.length, additionalSkillPaths: ownSkills.paths,
    // Session skill folders are random junctions. Keep their stable targets in the prompt on reopen/resume.
    // Pi has already selected the winner of duplicate names; sorting here does not change that precedence.
    skillsOverride: (base) => ({ ...base, skills: base.skills.filter((skill) => ownSkills.names.includes(skill.name))
      .map((skill) => {
        // Resolve only the directory: SKILL.md may itself link to shared text with local relative resources.
        const baseDir = realpathSync(dirname(skill.filePath));
        return { ...skill, filePath: join(baseDir, basename(skill.filePath)), baseDir };
      })
      .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) }),
    systemPromptOverride: () => config.systemPrompt,
    appendSystemPromptOverride: () => [],
    agentsFilesOverride: ({ agentsFiles }) => ({ agentsFiles: agentsFiles.filter((f) => dirname(resolve(f.path)) === resolve(cwd)) }),
    extensionFactories: [
      { name: 'daocut-compaction-evidence', hidden: true, factory: compactionEvidenceExtension },
      /* each request's pictures within the budget, the oldest left out first: the request only, never the session */
      { name: 'daocut-images', hidden: true, factory: (pi) => {
        pi.on('context', (event) => {
          const fitted = fitImages(event.messages, imageBudget);
          imagesSent = fitted.kept;
          return fitted.messages === event.messages ? undefined : { messages: fitted.messages };
        });
      } },
      { name: 'daocut-log', hidden: true, factory: (pi) => {
        pi.on('context_with_system', (event) => { pending = { startedAt: Date.now(), messages: event.messages, pricing: modelPricing(byId.get(ownOf(session.model).id)?.pricing) }; });
      } },
      { name: 'daocut-turn-policy', hidden: true, factory: (pi) => {
        /* Enforced before every tool body, including a provider that ignores tool_choice. This is turn-local;
           earlier editing authorization does not turn a new, complete greeting into a request to resume work. */
        pi.on('tool_call', () => {
          if (entry.turnPolicy.allowTools) return undefined;
          entry.toolsBlocked = true;
          return { block: true, terminate: true, reason: entry.turnPolicy.reason === 'product-structure'
            ? '本轮仅分析所选商品段的转写，不读取其他文件、不调用工具、不修改成片。'
            : '本轮只有问候，请直接回复，不执行工具或继续制作。' };
        });
      } },
      { name: 'daocut-ask', hidden: true, factory: (pi) => pi.registerTool(askTool(client, () => sessionId)) },
    ],
  });
  await resourceLoader.reload();
  const startEffort = byId.get(startModel)?.effort ?? 'auto';
  const { session } = await createAgentSession({
    cwd, agentDir: config.agentDir, modelRuntime, model: piModel(startModel, startEffort),
    ...(startEffort !== 'auto' ? { thinkingLevel: startEffort } : {}),
    resourceLoader, sessionManager, settingsManager, tools: ['read', 'bash', 'edit', 'write', 'ask'],
  });
  /* a request refused as too large is one Pi tries again (its retry: once, the failed attempt left out of what is sent)
     when it held pictures to leave out; Pi neither retries a 413 nor, but for Anthropic's own words, compacts for it */
  const retryable = session._isRetryableError.bind(session);
  session._isRetryableError = (message) => (TOO_LARGE.test(String(message?.errorMessage ?? '')) ? imagesSent > 0 : retryable(message));
  /* what it runs on now, as the chat names it (a conversation taken up again may be on another model and effort) */
  const now = ownOf(session.model);
  const onModel = now.id ?? startModel;
  const levels = byId.get(onModel)?.levels ?? ['auto'];
  const entry = { session, log: null, answer: null, overflow: null, model: onModel, turnPolicy: { allowTools: true }, toolsBlocked: false, replyText: false, productSubmission: null,
    effort: now.thinking && levels.includes(session.thinkingLevel) ? session.thinkingLevel : !now.thinking && levels.includes('auto') ? 'auto' : byId.get(onModel)?.effort ?? 'auto' };
  /* Pi's provider keeps only an error's message. Log transport causes before that normalization, for this turn. */
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    const log = entry.log;
    const noTools = !entry.turnPolicy.allowTools;
    /* Pi 1.1 carries tool declarations in system-message deltas as well as Context.tools. Strip only
       the outgoing copy; persisted history and the next editing turn keep their original declarations. */
    const requestContext = noTools ? { ...context, tools: [],
      messages: context.messages.map(message => message.role === 'system' && message.toolsAdded
        ? { ...message, toolsAdded: [] } : message),
    } : context;
    if (noTools && pending) pending.messages = requestContext.messages;
    const fetch = networkFetch(options?.fetch ?? globalThis.fetch, (failure) => log?.networkError(failure));
    // Keep this turn's guard in the closure even if cancellation settles it before a provider's late retry.
    const productSubmission = entry.turnPolicy.reason === 'product-structure' ? entry.productSubmission : null;
    return stream(model, requestContext, { ...options,
      ...(noTools ? { toolChoice: 'none' } : {}),
      // A scoped analysis is one explicit submission. Also block provider-SDK retries below Pi's retry setting.
      fetch: productSubmission ? (input, init) => {
        if (productSubmission.sent) throw new Error('本段请求已发送，未自动重试；请核查服务记录后显式重试。');
        productSubmission.sent = true;
        return fetch(input, init);
      } : fetch,
    });
  };
  session.agent.streamFunction = quotaStream(session.agent.streamFunction, {
    client, enabled: config.companyQuota === true,
    pricing: (model) => modelPricing(byId.get(ownOf(model).id)?.pricing),
    onRequest: (request) => { entry.quotaRequest = request; },
    onBlocked: () => { pending = null; entry.quotaRequest = null; },
    onWarning: () => process.stderr.write('company quota: receipt sync pending; original model log is retained.\n'),
  });
  installCompactionRecovery(session, {
    cwd,
    /* Summaries bypass context_with_system/message_end: record each actual attempt through the same usage log. */
    onCall: ({ model, context, response, startedAt }) => entry.log?.write({
      startedAt, messages: context.messages, toolsNow: context.tools ?? [],
      quotaRequestId: entry.quotaRequest?.id,
      pricing: modelPricing(byId.get(ownOf(model).id)?.pricing),
      answer: { message: response, systemPrompt: context.systemPrompt ?? null },
    }),
    onRetry: () => send({ sessionUpdate: 'notice', severity: 'warning',
      title: 'The conversation summary reached its output limit; retrying once. The original conversation is kept if compression fails.' }),
  });
  /* a conversation taken up again on a model no longer set up: on the one a session starts on */
  if (!now.id) await use(entry, onModel, entry.effort);
  sessionId = session.sessionId;
  const send = (update) => { void client.sessionUpdate({ sessionId, update }).catch(() => {}); };
  entry.sendContext = () => send(sessionContextUpdate(session, estimateTokens));
  entry.sendContext();
  send({ sessionUpdate: 'available_commands_update', availableCommands: [
    { name: 'compact', description: '压缩当前对话上下文，保留目标、约束和项目进度' },
  ] });

  session.subscribe((event) => {
    switch (event.type) {
      case 'message_update': {
        const e = event.assistantMessageEvent;
        if (e.type === 'text_delta') {
          entry.replyText ||= Boolean(e.delta?.trim());
          send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: e.delta } });
        }
        else if (e.type === 'thinking_delta') send({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: e.delta } });
        break;
      }
      case 'message_end': {
        const message = event.message;
        if (message?.role !== 'assistant') break;
        /* the turn's last answer: Pi drops one too long for the model from the conversation as it tries to recover */
        entry.answer = message;
        /* refused as too large: the request tried again (see below) carries half of its pictures */
        if (message.stopReason === 'error' && TOO_LARGE.test(String(message.errorMessage ?? '')) && imagesSent > 0) imageBudget = Math.floor(imagesSent / 2);
        if (pending && entry.log) {
          const toolsNow = (entry.turnPolicy.allowTools ? session.agent?.state?.tools ?? [] : []).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
          entry.log.write({ startedAt: pending.startedAt, messages: pending.messages, toolsNow, quotaRequestId: entry.quotaRequest?.id, pricing: pending.pricing, answer: { message, systemPrompt: session.systemPrompt } });
        }
        pending = null;
        /* Pi persists message_end after notifying listeners. turn_end reads its finalized projection. */
        break;
      }
      case 'turn_end':
      case 'agent_end':
        entry.sendContext();
        break;
      case 'tool_execution_start':
        if (!entry.turnPolicy.allowTools) break; // blocked attempts remain in Pi's session log, not shown as execution
        send({ sessionUpdate: 'tool_call', toolCallId: event.toolCallId, status: 'in_progress', ...toolCall(event.toolName, event.args) });
        break;
      case 'tool_execution_update': {
        if (!entry.turnPolicy.allowTools) break;
        const content = toolContent(event.partialResult);
        if (content.length) send({ sessionUpdate: 'tool_call_update', toolCallId: event.toolCallId, content });
        break;
      }
      case 'tool_execution_end':
        if (!entry.turnPolicy.allowTools) break;
        send({ sessionUpdate: 'tool_call_update', toolCallId: event.toolCallId, status: event.isError ? 'failed' : 'completed',
          content: toolContent(event.result), rawOutput: event.result?.content?.filter?.((b) => b?.type === 'text').map((b) => b.text).join('\n') ?? '' });
        break;
      case 'auto_retry_start':
        /* the service failed or sent nothing in time, and Pi tries again: the chat says so (nothing once it answers) */
        send(retryNotice(event));
        break;
      case 'compaction_start':
        /* Cancellation can arrive while compact() is awaiting its initial abort(), before its controller exists. */
        if (event.reason === 'manual' && entry.manualCompaction?.cancelled) session.abortCompaction();
        break;
      case 'compaction_end':
        entry.sendContext();
        /* Pi could not make room for the conversation: the turn ends on that (its last answer may not say it) */
        if (event.reason === 'overflow' && event.errorMessage) entry.overflow = event.errorMessage;
        break;
      default: break;
    }
  });
  sessions.set(sessionId, entry);
  return { sessionId, configOptions: optionsOf(entry), modes: null };
}

/** A prompt's blocks as Pi takes them: its text (files named by their path) and its pictures. */
function promptOf(blocks) {
  const text = [];
  const images = [];
  for (const b of blocks ?? []) {
    if (b?.type === 'text') text.push(b.text);
    else if (b?.type === 'image' && b.data) images.push({ type: 'image', data: b.data, mimeType: b.mimeType ?? 'image/png' });
    else if (b?.type === 'resource_link') text.push(`@${b.uri?.replace(/^file:\/\//, '') ?? b.name}`);
    else if (b?.type === 'resource' && typeof b.resource?.text === 'string') text.push(`<file path="${b.resource.uri}">\n${b.resource.text}\n</file>`);
  }
  return { text: text.join('\n'), images };
}

/**
 * A failure with its own text: the SDK sends a plain Error as "Internal error", its text only in `data`. Pi's own words,
 * when the text is plainer (pi-config.mjs failureText), go as `details`.
 */
function failed(e) {
  if (e instanceof acp.RequestError) return e;
  const text = e instanceof Error ? e.message : String(e);
  return new acp.RequestError(-32603, text, typeof e?.details === 'string' && e.details !== text ? { details: e.details } : undefined);
}

/** A request whose failure the chat shows as it is said. */
const said = (handler) => async (params) => {
  try { return await handler(params); } catch (e) { throw failed(e); }
};

const connection = new acp.AgentSideConnection((client) => ({
  async initialize() {
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { resume: {} } },
      agentInfo: { name: 'pi', title: 'Pi', version: VERSION },
      authMethods: [],
    };
  },
  async authenticate() { return {}; },
  newSession: said((params) => open(client, params.cwd, null)),
  resumeSession: said((params) => open(client, params.cwd, params.sessionId)),
  prompt: said(async (params) => {
    const entry = sessions.get(params.sessionId);
    if (!entry) throw new Error('This conversation has ended.');
    const { session } = entry;
    /* A command must not take over another turn's log or interrupt an edit implicitly. */
    if (entry.promptActive) throw new Error('请先等待当前任务完成，或停止后再试。');
    entry.promptActive = true;
    const meta = params._meta?.daocut ?? {};
    entry.log = typeof meta.turnId === 'string' && typeof meta.cwd === 'string' ? modelLog(meta.cwd, meta.turnId) : null;
    entry.answer = null;
    entry.overflow = null;
    entry.turnPolicy = turnToolPolicy(params.prompt);
    entry.toolsBlocked = false;
    entry.productSubmission = entry.turnPolicy.reason === 'product-structure' ? { sent: false } : null;
    entry.replyText = false;
    const priorAutoRetry = session.autoRetryEnabled;
    const priorAutoCompaction = session.autoCompactionEnabled;
    if (entry.turnPolicy.reason === 'product-structure') {
      session.setAutoRetryEnabled(false);
      session.setAutoCompactionEnabled(false);
    }
    try {
      if (isCompactionCommand(params.prompt)) {
        const operation = { cancelled: false };
        entry.manualCompaction = operation;
        const update = (status, extra = {}) => ({ 'daocut/compaction': { status, reason: 'manual', ...extra } });
        const reply = (text, status, extra) => client.sessionUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text },
          _meta: { 'daocut/localReply': true, ...update(status, extra) },
        } }).catch(() => {});
        await client.sessionUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: 'notice', severity: 'info', title: '正在压缩对话上下文',
          _meta: update('in_progress'),
        } }).catch(() => {});
        try {
          const result = await session.compact(COMPACTION_INSTRUCTIONS);
          await reply('已完成上下文压缩。后续对话将使用摘要和近期消息，上下文占比将在下一次回复后更新。', 'completed', {
            tokensBefore: result.tokensBefore, estimatedTokensAfter: result.estimatedTokensAfter,
          });
          return { stopReason: 'end_turn' };
        } catch (error) {
          if (operation.cancelled) {
            await reply('已取消上下文压缩，原对话内容已保留。', 'cancelled');
            return { stopReason: 'cancelled' };
          }
          if (['Already compacted', 'Nothing to compact (session too small)'].includes(error?.message)) {
            await reply(error.message === 'Already compacted' ? '当前对话已经压缩，无需重复压缩。' : '当前对话内容较少，暂时无需压缩。', 'skipped');
            return { stopReason: 'end_turn' };
          }
          await client.sessionUpdate({ sessionId: params.sessionId, update: {
            sessionUpdate: 'notice', severity: 'error', title: '上下文压缩失败，原对话内容已保留',
            _meta: update('failed'),
          } }).catch(() => {});
          throw Object.assign(new Error('上下文压缩失败，原对话内容已保留。' + (error?.message ? ' ' + error.message : '')), { details: error?.message });
        }
      }
      const { text, images } = promptOf(params.prompt);
      await session.prompt(text, images.length ? { images } : undefined);
      /* A provider may ignore tool_choice and return only forbidden calls. Finish visibly without a second
         model request; mark this as host text and leave the real model transcript and usage unchanged. */
      if (entry.toolsBlocked && (!entry.replyText || entry.turnPolicy.reason === 'product-structure')) {
        await client.sessionUpdate({ sessionId: params.sessionId, update: {
          sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: entry.turnPolicy.reason === 'product-structure'
            ? '模型尝试读取其他内容或执行工具，已停止。本段结构分析未完成，未自动重试。'
            : '你好，有什么需要我帮忙的？' },
          _meta: { 'daocut/localReply': true },
        } }).catch(() => {});
      }
      if (entry.toolsBlocked && entry.turnPolicy.reason === 'product-structure') {
        throw new Error('本段结构分析未完成：模型尝试调用工具，已停止，未自动重试。');
      }
      const last = entry.answer ?? [...session.messages].reverse().find((m) => m.role === 'assistant');
      return { stopReason: stopReason(entry.overflow && last?.stopReason !== 'aborted' ? { stopReason: 'error', errorMessage: entry.overflow } : last) };
    } finally {
      entry.promptActive = false;
      entry.manualCompaction = null;
      session.setAutoRetryEnabled(priorAutoRetry);
      session.setAutoCompactionEnabled(priorAutoCompaction);
      entry.turnPolicy = { allowTools: true };
      entry.toolsBlocked = false;
      entry.productSubmission = null;
      entry.replyText = false;
      entry.log?.end();
      entry.log = null;
    }
  }),
  setSessionConfigOption: said(async (params) => {
    const entry = sessions.get(params.sessionId);
    if (!entry) throw new Error('This conversation has ended.');
    if (params.configId === 'model') {
      const model = String(params.value);
      const own = byId.get(model);
      if (!own) throw new Error(`No model ${model}.`);
      /* the effort it was on, when this model takes it; else the one this model starts on */
      await use(entry, model, own.levels.includes(entry.effort) ? entry.effort : own.effort);
    } else if (params.configId === 'effort') {
      const effort = String(params.value);
      if (!(byId.get(entry.model)?.levels ?? []).includes(effort)) throw new Error(`${byId.get(entry.model)?.name ?? entry.model} does not take the effort ${effort}.`);
      await use(entry, entry.model, effort);
    } else throw new Error(`No option ${params.configId}.`);
    return { configOptions: optionsOf(entry) };
  }),
  async cancel(params) {
    const entry = sessions.get(params.sessionId);
    if (entry?.manualCompaction) {
      entry.manualCompaction.cancelled = true;
      entry.session.abortCompaction();
    }
    await entry?.session.abort();
  },
  async closeSession(params) {
    sessions.get(params.sessionId)?.session.dispose();
    sessions.delete(params.sessionId);
  },
}), acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));

await connection.closed;
for (const { session } of sessions.values()) session.dispose();
process.exit(0);
