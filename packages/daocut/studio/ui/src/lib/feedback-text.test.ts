import assert from 'node:assert/strict';
import test from 'node:test';
import { limitFeedbackText } from './feedback-text.ts';

for (const limit of [120, 8000]) {
  test(`feedback limit ${limit}: emoji crossing the boundary is omitted whole`, () => {
    const prefix = '中'.repeat(limit - 1);
    const result = limitFeedbackText(prefix + '🙂after', limit);
    assert.equal(result, prefix);
    assert.equal(result.length, limit - 1);
    assert.equal(new TextDecoder().decode(new TextEncoder().encode(result)), result);
  });

  test(`feedback limit ${limit}: a complete final emoji fits and counts as two UTF-16 units`, () => {
    const exact = 'a'.repeat(limit - 2) + '🙂';
    assert.equal(limitFeedbackText(exact, limit), exact);
    assert.equal(limitFeedbackText(exact + 'tail', limit), exact);
    const allEmoji = limitFeedbackText('🙂'.repeat(limit), limit);
    assert.equal(allEmoji.length, limit);
    assert.equal(Array.from(allEmoji).length, limit / 2);
  });

  test(`feedback limit ${limit}: ordinary Chinese and English retain the original limit and formatting`, () => {
    for (const character of ['中', 'a']) {
      const exact = character.repeat(limit);
      assert.equal(limitFeedbackText(exact, limit), exact);
      assert.equal(limitFeedbackText(exact + character, limit), exact);
    }
    assert.equal(limitFeedbackText('  中文 English🙂\n', limit), '  中文 English🙂\n');
    assert.equal(limitFeedbackText('', limit), '');
  });
}
