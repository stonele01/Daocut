/**
 * Pi 1.1's public compaction lifecycle and stream injection keep its own checkpoint prompts,
 * cut points and append-only session persistence. Only summary requests use a lower supported
 * thinking level and one bounded recovery attempt; ordinary agent requests pass through.
 * Evidence is archived locally and appended after a successful reply, never injected into summary requests.
 */
import { prepareCompactionEvidence, stripEvidenceFooter } from './pi-compaction-evidence.mjs';

const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const HEADROOM = 1024;

/** Remove only our mechanically appended block from Pi's temporary preparation.
 * Native split-turn compaction may carry previousSummary forward without a history request.
 */
export function compactionEvidenceExtension(pi) {
  pi.on('session_before_compact', ({ preparation }) => {
    if (preparation.previousSummary) preparation.previousSummary = stripEvidenceFooter(preparation.previousSummary);
  });
}

function summaryReasoning(model, original) {
  if (!model.reasoning) return original;
  return LEVELS.find((level) => typeof model.thinkingLevelMap?.[level] === 'string') ?? original;
}

function retryLimit(model, options, response) {
  const usage = response.usage;
  const input = [usage?.input, usage?.cacheRead ?? 0, usage?.cacheWrite ?? 0];
  if (input.some((value) => !Number.isSafeInteger(value) || value < 0) || input.reduce((a, b) => a + b, 0) === 0) {
    return { reason: 'The service did not report usable input-token usage, so the output budget could not be safely increased.' };
  }
  const maxTokens = Math.min(model.maxTokens, model.contextWindow - input.reduce((a, b) => a + b, 0) - HEADROOM, options.maxTokens * 2);
  if (!Number.isSafeInteger(maxTokens) || maxTokens < options.maxTokens) {
    return { reason: 'The remaining context leaves no room for a complete recovery summary.' };
  }
  return { maxTokens };
}

function sumUsage(usages) {
  const combined = { cost: {} };
  for (const usage of usages) {
    for (const [key, value] of Object.entries(usage ?? {})) {
      if (typeof value === 'number') combined[key] = (combined[key] ?? 0) + value;
    }
    for (const [key, value] of Object.entries(usage?.cost ?? {})) {
      if (typeof value === 'number') combined.cost[key] = (combined.cost[key] ?? 0) + value;
    }
  }
  return combined;
}

/**
 * Installs through SDK-supported session events and streamFunction. Pi's summary consumer
 * calls result(), so incomplete deltas are never substituted for the final checkpoint.
 * Native transient retries share the same one-extra-request budget with length recovery,
 * including when Pi creates both a history summary and a split-turn prefix summary.
 */
export function installCompactionRecovery(session, { cwd, onCall = () => {}, onRetry = () => {} } = {}) {
  let operation = null;
  session.subscribe((event) => {
    if (event.type === 'compaction_start') operation = { retryUsed: false, requests: new WeakMap(), evidence: null, evidenceAdded: false };
    if (event.type === 'compaction_end') operation = null;
  });
  const stream = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) => {
    const current = operation;
    if (!current) return stream(model, context, options);
    const previous = current.requests.get(context);
    if (previous && current.retryUsed) return { result: () => previous.promise };
    if (previous) current.retryUsed = true; // Pi's native transient retry uses the single extra attempt.
    const request = previous ?? { usages: [] };
    const initialOptions = { ...options, reasoning: summaryReasoning(model, options?.reasoning) };
    const produce = async (requestOptions) => {
      requestOptions.signal?.throwIfAborted();
      if (cwd && !current.evidence) current.evidence = prepareCompactionEvidence(session.sessionManager, cwd);
      const startedAt = Date.now();
      const response = await (await stream(model, context, requestOptions)).result();
      onCall({ model, context, response, startedAt });
      if (response.usage) request.usages.push(response.usage);
      requestOptions.signal?.throwIfAborted();
      if (response.stopReason === 'aborted') throw new Error('Summarization cancelled; conversation history was preserved.');
      return response;
    };
    request.promise = (async () => {
      let response = await produce(initialOptions);
      let reason = 'The single summary recovery attempt also reached its output limit.';
      if (response.stopReason === 'length' && !current.retryUsed) {
        const limit = retryLimit(model, initialOptions, response);
        reason = limit.reason ?? reason;
        if (limit.maxTokens) {
          current.retryUsed = true;
          onRetry({ maxTokens: limit.maxTokens });
          response = await produce({ ...initialOptions, maxTokens: limit.maxTokens });
        }
      }
      if (response.stopReason === 'length') {
        throw new Error(`Summarization failed: generation hit the token cap and the summary is incomplete. ${reason} Conversation history was preserved.`);
      }
      if (response.stopReason === 'stop' && !response.content.some(block => block.type === 'text' && block.text.trim())) {
        throw new Error('Summarization failed: empty checkpoint. Conversation history was preserved.');
      }
      if (current.evidence && !current.evidenceAdded && response.stopReason === 'stop'
          && !response.content.some(block => block.type === 'toolCall')) {
        // This is local mechanical retention after the model reply, not a new summary prompt.
        response = { ...response, content: [...response.content, { type: 'text', text: '\n\n' + current.evidence.footer }] };
        current.evidenceAdded = true;
      }
      return request.usages.length > 1 ? { ...response, usage: sumUsage(request.usages) } : response;
    })();
    current.requests.set(context, request);
    return { result: () => request.promise };
  };
}
