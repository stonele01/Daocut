import { readFile } from 'node:fs/promises';

// Complete reviewed rules, shipped with the server. Tests compare these files
// with the user-approved review copy so judgment requirements cannot disappear.
const read = async name => (await readFile(new URL(`./prompts/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n').trim();
export const DISCOVER_PRODUCTS_PROMPT = await read('01-discover-products.txt');
export const ANALYZE_SPEECH_PROMPT = await read('02-analyze-speech.txt');
export const COMPOSE_STRUCTURE_PROMPT = await read('03-compose-structure.txt');
