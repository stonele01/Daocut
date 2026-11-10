/**
 * `ask`: the agent's questions to the person, each with its options and room for their own words, as an ACP form (the
 * shape agents.mjs formQuestions reads: a field per question, a choice a `oneOf`, beside it a field for the person's own
 * words). Reports their actual answers, unanswered questions, skipped input, or a transport error.
 */
export function askTool(client, sessionOf) {
  return {
    name: 'ask',
    label: 'Ask',
    description: 'Ask the person one to three questions, each with two to five short options to choose from; they can also '
      + 'answer in their own words. The turn waits for the answer. Only for a choice you cannot make well yourself.',
    parameters: {
      type: 'object',
      required: ['questions'],
      properties: {
        questions: {
          type: 'array', minItems: 1, maxItems: 3,
          items: {
            type: 'object',
            required: ['question', 'options'],
            properties: {
              question: { type: 'string', description: 'The question, as a full sentence.' },
              header: { type: 'string', description: 'A label of a few words.' },
              options: {
                type: 'array', minItems: 2, maxItems: 5,
                items: { type: 'object', required: ['label'], properties: { label: { type: 'string' }, description: { type: 'string' } } },
              },
              multiSelect: { type: 'boolean', description: 'More than one option may be chosen.' },
            },
          },
        },
      },
    },
    async execute(toolCallId, params) {
      const questions = (params?.questions ?? []).slice(0, 3);
      const properties = {};
      questions.forEach((q, i) => {
        const choices = (q.options ?? []).map((o) => ({ const: String(o.label), title: String(o.label), ...(o.description ? { description: String(o.description) } : {}) }));
        properties[`q${i}`] = q.multiSelect
          ? { type: 'array', title: q.header ?? '', description: q.question, items: { anyOf: choices } }
          : { type: 'string', title: q.header ?? '', description: q.question, oneOf: choices };
        properties[`q${i}_own`] = { type: 'string', title: 'In your own words', _meta: { _askUserQuestionCustomAnswer: { questionId: `q${i}` } } };
      });
      let reply;
      try {
        reply = await client.createElicitation({
          sessionId: sessionOf(), toolCallId, mode: 'form', message: questions[0]?.question ?? '',
          requestedSchema: { type: 'object', properties },
        });
      } catch (error) {
        return result({ status: 'error', error: error instanceof Error ? error.message : String(error) });
      }
      if (reply.action === 'cancel' || reply.action === 'decline') return result({ status: 'skipped', action: reply.action });
      if (reply.action !== 'accept') return result({ status: 'error', error: 'The question returned an unsupported response action.' });
      const answers = questions.map((q, i) => {
        const own = reply.content?.[`q${i}_own`];
        const chosen = reply.content?.[`q${i}`];
        const answer = typeof own === 'string' && own.trim() ? own.trim()
          : Array.isArray(chosen) ? chosen.filter(value => typeof value === 'string' && value.trim())
          : typeof chosen === 'string' && chosen.trim() ? chosen : null;
        const answered = Array.isArray(answer) ? answer.length > 0 : answer !== null;
        return { question: q.question, status: answered ? 'answered' : 'unanswered', ...(answered ? { answer } : {}) };
      });
      return result({ status: answers.some(answer => answer.status === 'answered') ? 'answered' : 'unanswered', questions: answers });
    },
  };
}

/** Keep user-input outcomes in the model-visible content, without adding instructions on their behalf. */
const result = outcome => ({ content: [{ type: 'text', text: JSON.stringify(outcome) }], details: {} });
