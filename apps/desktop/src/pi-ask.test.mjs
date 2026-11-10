import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askTool } from './pi-ask.mjs';

const question = (text = 'Which direction?', extra = {}) => ({
  question: text, header: 'Direction', options: [{ label: 'Simple', description: 'Less detail' }, { label: 'Detailed' }], ...extra,
});
const visible = result => {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, 'text');
  assert.doesNotMatch(result.content[0].text, /decide yourself|say what you chose|carry on/i);
  return JSON.parse(result.content[0].text);
};
const execute = (reply, questions = [question()]) => askTool({ createElicitation: async () => reply }, () => 'session-1')
  .execute('tool-1', { questions }).then(visible);

test('ask waits for the real response and sends the ACP form and selected answer intact', async () => {
  const { promise, resolve } = Promise.withResolvers();
  let request;
  let completed = false;
  const tool = askTool({ createElicitation: params => { request = params; return promise; } }, () => 'session-1');
  const pending = tool.execute('tool-1', { questions: [question()] }).then(result => { completed = true; return visible(result); });
  await Promise.resolve();
  assert.equal(completed, false, 'no default decision before the user responds');
  assert.equal(request.sessionId, 'session-1');
  assert.equal(request.toolCallId, 'tool-1');
  assert.equal(request.mode, 'form');
  assert.equal(request.message, 'Which direction?');
  assert.deepEqual(request.requestedSchema.properties.q0.oneOf, [
    { const: 'Simple', title: 'Simple', description: 'Less detail' }, { const: 'Detailed', title: 'Detailed' },
  ]);
  assert.deepEqual(request.requestedSchema.properties.q0_own._meta, { _askUserQuestionCustomAnswer: { questionId: 'q0' } });
  resolve({ action: 'accept', content: { q0: 'Detailed' } });
  assert.deepEqual(await pending, { status: 'answered', questions: [{ question: 'Which direction?', status: 'answered', answer: 'Detailed' }] });
});

test('a custom answer takes precedence and retains multiline user wording', async () => {
  const answer = 'Use my existing footage.\nKeep the original price conditions.';
  const result = await execute({ action: 'accept', content: { q0: 'Simple', q0_own: `  ${answer}  ` } });
  assert.equal(result.status, 'answered');
  assert.equal(result.questions[0].answer, answer);
});

test('multiple selections remain separate values, including a label containing a comma', async () => {
  const choices = ['Product, in use', 'Close-up'];
  let request;
  const tool = askTool({ createElicitation: async params => { request = params; return { action: 'accept', content: { q0: choices } }; } }, () => 'session-1');
  const result = visible(await tool.execute('tool-1', { questions: [question('Which shots?', { multiSelect: true, options: choices.map(label => ({ label })) })] }));
  assert.equal(request.requestedSchema.properties.q0.type, 'array');
  assert.deepEqual(request.requestedSchema.properties.q0.items.anyOf.map(choice => choice.const), choices);
  assert.deepEqual(result.questions[0].answer, choices);
});

test('partial answers preserve the supplied choice and mark each omitted question unanswered', async () => {
  const result = await execute({ action: 'accept', content: { q0: 'Simple' } }, [question(), question('Which source?')]);
  assert.deepEqual(result, { status: 'answered', questions: [
    { question: 'Which direction?', status: 'answered', answer: 'Simple' },
    { question: 'Which source?', status: 'unanswered' },
  ] });
});

test('accepted blank text, empty selections and missing fields do not invent an answer', async () => {
  const result = await execute({ action: 'accept', content: { q0: ' ', q0_own: '\n', q1: [] } }, [question(), question('Which shots?', { multiSelect: true }), question('Which source?')]);
  assert.equal(result.status, 'unanswered');
  assert.deepEqual(result.questions.map(item => item.status), ['unanswered', 'unanswered', 'unanswered']);
  assert.ok(result.questions.every(item => !('answer' in item)));
  const missing = await execute({ action: 'accept' });
  assert.equal(missing.status, 'unanswered');
});

for (const action of ['cancel', 'decline']) {
  test(`${action} reports skipped input without selecting an option or granting a new task`, async () => {
    assert.deepEqual(await execute({ action }), { status: 'skipped', action });
  });
}

test('an elicitation rejection is a model-visible error, not a user cancellation', async () => {
  const tool = askTool({ createElicitation: async () => { throw new Error('Elicitation connection closed'); } }, () => 'session-1');
  const result = visible(await tool.execute('tool-1', { questions: [question()] }));
  assert.deepEqual(result, { status: 'error', error: 'Elicitation connection closed' });
});

test('a synchronous transport error is also reported without attributing a decision to the user', async () => {
  const tool = askTool({ createElicitation: () => { throw new Error('Client unavailable'); } }, () => 'session-1');
  const result = visible(await tool.execute('tool-1', { questions: [question()] }));
  assert.deepEqual(result, { status: 'error', error: 'Client unavailable' });
});

test('an unrecognized response is an error rather than a fabricated skip', async () => {
  assert.equal((await execute({ action: 'unexpected' })).status, 'error');
});
