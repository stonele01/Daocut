import { mkdir, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { probe } from './derived.mjs';
import { HttpError, json, readJson } from './http.mjs';
import { TOOL_DIR } from './projects.mjs';

export const PRODUCT_ANALYSIS_FILE = `${TOOL_DIR}/product-analysis.json`;
const empty = () => ({ version: 1, sources: [], products: [], intervals: [], candidates: [] });
const record = v => v && typeof v === 'object' && !Array.isArray(v);
const str = v => typeof v === 'string' && v.length > 0;
const num = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const fail = message => { throw new HttpError(400, `product-analysis: ${message}`); };

function validate(data) {
  if (!record(data) || data.version !== 1) fail('expected version 1');
  for (const key of ['sources', 'products', 'intervals', 'candidates']) if (!Array.isArray(data[key])) fail(`${key} must be an array`);
  for (const key of ['sources', 'products', 'intervals', 'candidates']) {
    const ids = new Set();
    for (const item of data[key]) {
      if (!record(item) || !str(item.id) || ids.has(item.id)) fail(`${key} has an invalid or duplicate id`);
      ids.add(item.id);
    }
  }
  const sources = new Map(data.sources.map(s => [s.id, s]));
  const products = new Map(data.products.map(p => [p.id, p]));
  if (data.scopes !== undefined && !Array.isArray(data.scopes)) fail('scopes must be an array');
  const scopes = data.scopes ?? [];
  const intervals = new Map(data.intervals.map(i => [i.id, i]));
  for (const scope of scopes) {
    if (!record(scope) || !str(scope.id) || intervals.has(scope.id) || !['confirmed-inspection', 'historical-analysis'].includes(scope.kind) || scope.confirmed !== true || !sources.has(scope.sourceId) || !products.get(scope.productId)?.sourceIds.includes(scope.sourceId) || !num(scope.startMs) || !num(scope.endMs) || scope.startMs >= scope.endMs || (sources.get(scope.sourceId).durationMs !== null && scope.endMs > sources.get(scope.sourceId).durationMs)) fail('invalid inspection scope');
    intervals.set(scope.id, scope);
  }
  for (const s of data.sources) if (!str(s.assetPath) || !(s.durationMs === null || (num(s.durationMs) && s.durationMs > 0))) fail('invalid source');
  for (const p of data.products) if (!str(p.name) || !Array.isArray(p.sourceIds) || new Set(p.sourceIds).size !== p.sourceIds.length || p.sourceIds.some(id => !sources.has(id))) fail('invalid product sources');
  for (const i of data.intervals) {
    const s = sources.get(i.sourceId), p = products.get(i.productId);
    if (!s || !p || !p.sourceIds.includes(i.sourceId) || !num(i.startMs) || !num(i.endMs) || i.startMs >= i.endMs || (s.durationMs !== null && i.endMs > s.durationMs)) fail('invalid interval or references');
  }
  for (const c of data.candidates) {
    const i = intervals.get(c.intervalId);
    if (!i || c.productId !== i.productId || c.sourceId !== i.sourceId || !num(c.startMs) || !num(c.endMs) || c.startMs >= c.endMs || (i.kind && (c.startMs < i.startMs || c.endMs > i.endMs)) || (sources.get(c.sourceId).durationMs !== null && c.endMs > sources.get(c.sourceId).durationMs) || typeof c.text !== 'string' || !Array.isArray(c.tags) || c.tags.some(t => typeof t !== 'string') || !str(c.origin) || !(str(c.version) || num(c.version))) fail('invalid candidate or references');
  }
  if (data.unassigned !== undefined) {
    if (!Array.isArray(data.unassigned)) fail('unassigned must be an array');
    const ids = new Set();
    for (const range of data.unassigned) {
      const source = sources.get(range?.sourceId);
      if (!record(range) || !str(range.id) || ids.has(range.id) || intervals.has(range.id) || !source || !num(range.startMs) || !num(range.endMs) || range.startMs >= range.endMs || (source.durationMs !== null && range.endMs > source.durationMs) || !['mixed', 'mention', 'uncertain', 'transition'].includes(range.kind) || !str(range.reason) || range.productId !== undefined) fail('invalid unassigned range');
      ids.add(range.id);
    }
  }
  if (data.archivedCandidates !== undefined && (!Array.isArray(data.archivedCandidates) || data.archivedCandidates.some(c => !record(c) || !str(c.id) || !str(c.sourceId) || !str(c.productId) || !str(c.intervalId) || !num(c.startMs) || !num(c.endMs) || c.startMs >= c.endMs || typeof c.text !== 'string' || !Array.isArray(c.tags)))) fail('invalid archived candidates');
  if (data.manualEdits !== undefined && (!Array.isArray(data.manualEdits) || data.manualEdits.some(edit => !record(edit) || !str(edit.id) || !str(edit.createdAt) || !['manual-save', 'apply-proposal'].includes(edit.action) || !Array.isArray(edit.sourceIds) || !record(edit.before) || !record(edit.after)))) fail('invalid manual edit history');
  if (data.discoveryApplied !== undefined && (!Array.isArray(data.discoveryApplied) || data.discoveryApplied.some(item => !record(item) || !sources.has(item.sourceId) || !str(item.runId)))) fail('invalid applied discovery reference');
  return data;
}
export { validate as validateProductAnalysis };

export async function readProductAnalysis(root) {
  let data;
  try { data = JSON.parse(await readFile(join(root, PRODUCT_ANALYSIS_FILE), 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { analysis: empty(), history: null };
    throw new HttpError(409, 'product-analysis file cannot be read; it was not overwritten');
  }
  try {
    const { history = null, ...analysis } = data;
    validate(analysis);
    if (history !== null) validate(history);
    return { analysis, history };
  } catch { throw new HttpError(409, 'product-analysis file is invalid or has an unsupported version; it was not overwritten'); }
}

async function saveProductAnalysis(root, next, probeSource, preserveHistory = false) {
  validate(next);
  const previous = await readProductAnalysis(root);
  const saved = [previous.analysis, previous.history].filter(Boolean);
  const trusted = (kind, item, fields) => saved.some(snapshot => (snapshot[kind] ?? []).some(old => fields.every(field => old[field] === item[field])));
  const toProbe = new Set();
  for (const s of next.sources) if (next.intervals.some(i => i.sourceId === s.id) && !trusted('sources', s, ['id', 'assetPath', 'durationMs'])) toProbe.add(s.id);
  for (const kind of ['intervals', 'candidates', 'scopes', 'unassigned']) for (const item of next[kind] ?? []) {
    if (!trusted(kind, item, ['id', 'sourceId', 'startMs', 'endMs'])) toProbe.add(item.sourceId);
  }
  for (const id of toProbe) {
    const s = next.sources.find(source => source.id === id);
    let duration;
    try { duration = (await probeSource(root, s.assetPath)).duration; }
    catch { throw new HttpError(400, `product-analysis: cannot probe source ${id}`); }
    if (!Number.isFinite(duration) || duration <= 0) fail(`source ${id} has no duration`);
    const durationMs = Math.floor(duration * 1000);
    if ([...next.intervals, ...next.candidates, ...(next.scopes ?? []), ...(next.unassigned ?? [])].some(i => i.sourceId === id && i.endMs > durationMs)) fail(`source ${id} exceeds probed duration`);
    s.durationMs = durationMs;
  }
  const { history: ignored, ...analysis } = next;
  const history = preserveHistory ? previous.history : previous.analysis;
  const path = join(root, PRODUCT_ANALYSIS_FILE);
  await mkdir(dirname(path), { recursive: true });
  await writeAtomic(path, `${JSON.stringify({ ...analysis, history }, null, 2)}\n`);
  return { analysis, history };
}

const writes = new Map();
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function recordProductEdit(previous, next, action = 'manual-save') {
  const snapshot = data => ({ products: structuredClone(data.products), intervals: structuredClone(data.intervals), unassigned: structuredClone(data.unassigned ?? []) });
  const before = snapshot(previous), after = snapshot(next);
  if (JSON.stringify(canonical(before)) === JSON.stringify(canonical(after))) return next;
  return { ...next, manualEdits: [...(previous.manualEdits ?? []), { id: randomUUID(), createdAt: new Date().toISOString(), action, sourceIds: [...new Set([...before.products.flatMap(product => product.sourceIds), ...after.products.flatMap(product => product.sourceIds), ...[...before.intervals, ...after.intervals, ...before.unassigned, ...after.unassigned].map(item => item.sourceId)])], before, after }] };
}
export async function writeProductAnalysis(root, next, probeSource = probe, expected) {
  const pending = writes.get(root) ?? Promise.resolve();
  const write = pending.catch(() => {}).then(async () => {
    if (expected !== undefined) {
      const current = (await readProductAnalysis(root)).analysis;
      if (JSON.stringify(canonical(current)) !== JSON.stringify(canonical(expected))) throw new HttpError(409, 'product-analysis changed since it was read; reload before saving');
    }
    return saveProductAnalysis(root, next, probeSource);
  });
  writes.set(root, write);
  try { return await write; }
  finally { if (writes.get(root) === write) writes.delete(root); }
}
/** Merge inside the same queue as PUT, so background results cannot replace an intervening edit. */
export async function updateProductAnalysis(root, update, probeSource = probe, { preserveHistory = false } = {}) {
  const pending = writes.get(root) ?? Promise.resolve();
  const write = pending.catch(() => {}).then(async () => {
    const { analysis } = await readProductAnalysis(root);
    const next = await update(structuredClone(analysis));
    if (JSON.stringify(canonical(next)) === JSON.stringify(canonical(analysis))) return readProductAnalysis(root);
    return saveProductAnalysis(root, next, probeSource, preserveHistory);
  });
  writes.set(root, write);
  try { return await write; }
  finally { if (writes.get(root) === write) writes.delete(root); }
}
export async function productAnalysisRoute(req, res, root, rest) {
  if (rest !== 'product-analysis') return false;
  if (req.method === 'GET') { json(res, 200, await readProductAnalysis(root)); return true; }
  if (req.method === 'PUT') {
    const body = await readJson(req);
    if (!record(body)) fail('expected { analysis }');
    const current = (await readProductAnalysis(root)).analysis;
    const extended = body.expected !== undefined || body.analysis?.unassigned !== undefined || current.unassigned !== undefined || current.discoveryApplied !== undefined;
    if (extended && body.expected === undefined) throw new HttpError(409, 'product-analysis: expected snapshot is required for manual corrections');
    // A browser edits effective ranges. Historical AI input and manual revisions stay server-owned.
    const next = extended ? recordProductEdit(current, { ...body.analysis, manualEdits: current.manualEdits, discoveryApplied: current.discoveryApplied }) : body.analysis;
    json(res, 200, await writeProductAnalysis(root, next, probe, body.expected));
    return true;
  }
  return false;
}
