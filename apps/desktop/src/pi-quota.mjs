/** One local company reservation per real SDK stream, including summary and retry streams. */
import { randomUUID } from 'node:crypto';
import { estimateTokens } from '@earendil-works/pi-coding-agent';
import { reportedUsage } from './model-usage.mjs';
import { companyUsageEvent } from './company-usage.mjs';
import { QUOTA_RESERVE, QUOTA_SETTLE, QUOTA_RELEASE } from './company-quota.mjs';

export function quotaReservationTokens(model, context, options) {
  // Pi's existing context estimate is deliberately an estimate, not a provider bill.
  // Keep every original output/thinking option: quota must never lower editing quality.
  const messages = context.messages ?? [];
  let input = messages.reduce((sum, message) => sum + estimateTokens(message), 0);
  if (context.systemPrompt) input += Math.ceil(context.systemPrompt.length / 4);
  if (context.tools?.length) input += Math.ceil(JSON.stringify(context.tools).length / 4);
  const output = Number.isSafeInteger(options?.maxTokens) && options.maxTokens > 0 ? options.maxTokens : model.maxTokens;
  if (!Number.isSafeInteger(output) || output <= 0) throw new Error('模型输出上限无效，无法预留公司 Token 额度。');
  return Math.max(1, input + output);
}

export function quotaStream(stream, { client, enabled, onRequest = () => {}, onBlocked = () => {}, pricing = () => null, onWarning = () => {} }) {
  if (!enabled) return stream;
  return async (model, context, options) => {
    const id = randomUUID(), startedAt = Date.now();
    const input = { id, model: String(model.id).slice(0, 160), reservedTokens: quotaReservationTokens(model, context, options) };
    options?.signal?.throwIfAborted();
    try { await client.request(QUOTA_RESERVE, input); }
    catch (error) { onBlocked(error); throw error; }
    if (options?.signal?.aborted) {
      await client.request(QUOTA_RELEASE, { id, reason: 'not-sent' }).catch(onWarning);
      options.signal.throwIfAborted();
    }
    onRequest({ id, startedAt });
    // From this point a thrown transport error is uncertain; never release it as an unused request.
    const response = await stream(model, context, options);
    const settled = response.result().then(async answer => {
      if (reportedUsage(answer)) {
        const event = companyUsageEvent({ answer, pricing: pricing(model) }, { id, at: new Date(startedAt).toISOString(), model: model.id });
        try { await client.request(QUOTA_SETTLE, { event }); }
        catch (error) { onWarning(error); } // original model log is another durable recovery source
      }
      return answer;
    });
    // Start receipt handling immediately even if cancellation stops consumption of deltas.
    settled.catch(onWarning);
    return {
      result: () => settled,
      async *[Symbol.asyncIterator]() {
        for await (const event of response) {
          if (event.type === 'done' || event.type === 'error') await settled;
          yield event;
        }
      },
    };
  };
}
