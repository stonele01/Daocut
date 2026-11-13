import { readFile } from 'node:fs/promises';

// Complete reviewed rules, shipped with the server. Tests compare these files
// with the user-approved review copy so judgment requirements cannot disappear.
const read = async name => (await readFile(new URL(`./prompts/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trim();
export const PREVIOUS_DISCOVER_PRODUCTS_PROMPT = await read('01-discover-products-v1.txt');
export const PREVIOUS_CURATED_ANALYZE_SPEECH_PROMPT = await read('02-analyze-speech-curated-v1.txt');
export const PREVIOUS_ATTRIBUTED_ANALYZE_SPEECH_PROMPT = await read('02-analyze-speech-curated-v2.txt');
export const DISCOVER_PRODUCTS_PROMPT = await read('01-discover-products.txt');
export const PREVIOUS_CONTEXT_ANALYZE_SPEECH_PROMPT = await read('02-analyze-speech-curated-v3.txt');
export const ANALYZE_SPEECH_PROMPT = await read('02-analyze-speech-curated.txt');
export const PREVIOUS_SENTENCE_ANALYZE_SPEECH_PROMPT = await read('02-analyze-speech.txt');
export const COMPOSE_STRUCTURE_PROMPT = await read('03-compose-structure.txt');
// Frozen full prompts remain available for saved requests and their exact identities.
export const PREVIOUS_ANALYZE_SPEECH_PROMPT = await read('02-analyze-speech-v2.txt');
export const PREVIOUS_COMPOSE_STRUCTURE_PROMPT = await read('03-compose-structure-v2.txt');
