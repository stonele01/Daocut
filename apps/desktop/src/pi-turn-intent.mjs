/**
 * A deliberately narrow, local per-turn boundary; not a natural-language intent classifier.
 *
 * A complete greeting with no attached content is conversational even if an earlier task exists.
 * Disable tools for this turn only. The caller retains the session and any previous task.
 * Everything else stays with the primary model and the existing execution permissions: a
 * greeting embedded in an editing request, a quoted title, a short continuation, or an attachment
 * must not be mistaken for a greeting-only turn. No extra model request or dependency is used.
 */
const GREETING = /^[\s.,，。!！?？、;；:：…~～]*(?:你好|您好|哈喽|hello|hi|hey)[\s.,，。!！?？、;；:：…~～]*$/iu;

/** The chat supplies a server-checked snapshot; a tag mentioned in ordinary prose is not a mode switch. */
function productStructureContext(text) {
  const matches = [...text.matchAll(/<product_structure_context>\s*([\s\S]*?)\s*<\/product_structure_context>/g)];
  if (matches.length !== 1) return false;
  try {
    const value = JSON.parse(matches[0][1]);
    const scope = value?.scope;
    return scope && ['sourceId', 'productId', 'intervalId', 'productName'].every(key => typeof scope[key] === 'string' && scope[key].trim())
      && Number.isFinite(scope.startMs) && Number.isFinite(scope.endMs) && scope.startMs >= 0 && scope.endMs > scope.startMs
      && typeof value.transcriptVersion === 'string' && value.transcriptVersion.trim()
      && Array.isArray(value.segments) && value.segments.length > 0
      && value.segments.every(segment => segment && Number.isFinite(segment.startMs) && Number.isFinite(segment.endMs)
        && segment.startMs >= scope.startMs && segment.endMs <= scope.endMs && segment.endMs > segment.startMs
        && typeof segment.text === 'string' && segment.text.trim());
  } catch { return false; }
}

/**
 * @param {unknown} promptBlocks The current ACP prompt's content blocks, before promptOf flattens them.
 * @returns {{ allowTools: boolean, reason?: 'greeting-only' | 'product-structure' }}
 */
export function turnToolPolicy(promptBlocks) {
  if (!Array.isArray(promptBlocks) || promptBlocks.length === 0) return { allowTools: true };
  if (promptBlocks.some(block => block?.type !== 'text' || typeof block.text !== 'string')) {
    return { allowTools: true };
  }
  const text = promptBlocks.map(block => block.text).join('\n');
  if (productStructureContext(text)) return { allowTools: false, reason: 'product-structure' };
  return GREETING.test(text) ? { allowTools: false, reason: 'greeting-only' } : { allowTools: true };
}
