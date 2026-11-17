/** Open personal projects from existing shared AI artifacts only.
 * Reopen retries are limited to newly-recorded, unchanged empty projects. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeAtomic } from './atomic.mjs';
import { readProductAnalysis } from './product-analysis.mjs';
import { hasSavedProductResult } from './product-preparation.mjs';
import { sharedHash } from './shared-analysis.mjs';
import { HttpError } from './http.mjs';
import { structureDraftPrivateState } from './structure-drafts.mjs';

const fileFor = root => join(root, '.film/shared-open.json');
const openings = new Map();
export async function readSharedProjectOpen(root) {
  try {
    const saved = JSON.parse(await readFile(fileFor(root), 'utf8'));
    if (saved.version !== 1 || !saved.sharedRead) throw Error('打开记录格式不兼容');
    if (saved.sharedRead.status === 'opening') return { ...saved.sharedRead, status: 'review-required', warnings: [...saved.sharedRead.warnings, '上次读取已有分析时中断，已保存的内容保留，请核对记录；没有重新分析'] };
    return saved.sharedRead;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function privateFiles(root) {
  const read = async file => { try { return sharedHash(await readFile(join(root, file), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  return Promise.all([...['film.html', '.film/source-takes.json'].map(read), structureDraftPrivateState(root)]);
}
const changeError = () => new HttpError(409, '工程已有个人修改，保留当前内容，请在已有分析记录中核对采用');

export function openNewSharedProject(root, input, dependencies) {
  const pending = openings.get(root); if (pending) return pending;
  const work = open(root, input, dependencies).finally(() => openings.delete(root));
  openings.set(root, work); return work;
}

/** Explicitly fill missing public results in an existing personal project.
 * Keep the current transcript, product edits and film; do not restart discovery. */
export function resumeSharedAnalyses(root, sourceId, publication) {
  if (openings.has(root)) throw new HttpError(409, '正在读取共享结果，请稍候');
  const work = (async () => {
    let expected = (await readProductAnalysis(root)).analysis;
    if (!expected.sources.some(source => source.id === sourceId)) throw new HttpError(404, '来源不存在');
    const privateBefore = await privateFiles(root);
    const unchanged = async () => {
      if (sharedHash((await readProductAnalysis(root)).analysis) !== sharedHash(expected) || sharedHash(await privateFiles(root)) !== sharedHash(privateBefore)) throw changeError();
    };
    const { results } = await publication.catalog(root, sourceId);
    const preferred = await publication.preferredResults?.(root, sourceId) ?? new Set();
    await unchanged();
    const report = { readerRevision: 3, status: 'ready', imported: { transcription: 0, discovery: 0, analysis: 0 }, warnings: [], requestCount: 0, skippedRecords: 0, failedRecords: 0 };
    let live;
    try { live = JSON.parse(await readFile(join(root, '.film/live-analysis', `${sharedHash(sourceId)}.json`), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const present = new Set(Object.values(live?.analyses ?? {}).flatMap(value => [value.sharedRef?.sha256, value.historicalRef?.sha256]).filter(Boolean));
    const rows = results.filter(row => row.action === 'analysis');
    for (const row of rows) {
      await unchanged();
      if (present.has(row.resultSha)) { report.skippedRecords++; continue; }
      const versions = rows.filter(other => sharedHash(other.scope) === sharedHash(row.scope));
      if (versions.length > 1 && !preferred.has(row.resultSha)) {
        if (!versions.some(other => preferred.has(other.resultSha))) report.warnings.push('同一范围有多个历史版本，请在已有分析记录中选择采用');
        report.skippedRecords++; continue;
      }
      try {
        const imported = await publication.importResult(root, { sourceId, taskKey: row.taskKey, resultSha: row.resultSha, confirmed: true, expectedAnalysis: expected, preservePrevious: versions.length > 1,
          productName: `已有话术（商品待核对） ${Math.floor(row.scope.startMs / 1000)}–${Math.ceil(row.scope.endMs / 1000)}秒` });
        expected = imported.analysis;
        report.imported.analysis += row.count ?? imported.count ?? 0;
        if (imported.needsReview && imported.reason && !report.warnings.includes(imported.reason)) report.warnings.push(imported.reason);
      } catch (error) {
        await unchanged();
        report.failedRecords++;
        report.warnings.push(`范围 ${Math.floor(row.scope.startMs / 1000)}–${Math.ceil(row.scope.endMs / 1000)}秒未导入：${error.message}`);
      }
    }
    await unchanged();
    if (publication.restoreCompositions) expected = (await publication.restoreCompositions(root, sourceId, expected)).analysis;
    await unchanged();
    if (publication.restoreLayout) {
      const restored = await publication.restoreLayout(root, sourceId);
      expected = restored.analysis;
      if (expected.sharedLayouts?.[sourceId]) report.warnings = report.warnings.filter(w => !/商品关联|独立分析范围|商品待核对/.test(w));
    }
    report.status = report.warnings.length ? 'review-required' : 'ready';
    await writeAtomic(fileFor(root), `${JSON.stringify({ version: 1, sourceId, sharedRead: report })}\n`);
    return report;
  })().finally(() => openings.delete(root));
  openings.set(root, work);
  return work;
}
/** Only new empty records with an unchanged private baseline may be retried on an ordinary reopen. */
export function refreshEmptySharedProject(root, dependencies) {
  const pending = openings.get(root); if (pending) return pending;
  const work = (async () => {
    const report = await readSharedProjectOpen(root);
    if (report?.status !== 'empty') return report;
    const saved = JSON.parse(await readFile(fileFor(root), 'utf8'));
    const baseline = saved.emptyBaseline;
    if (!baseline || typeof baseline.analysisHash !== 'string' || !Array.isArray(baseline.privateFiles)) return report;
    const analysis = (await readProductAnalysis(root)).analysis, privateNow = await privateFiles(root);
    if (sharedHash(analysis) !== baseline.analysisHash || sharedHash(privateNow) !== sharedHash(baseline.privateFiles)) return report;
    const source = analysis.sources.find(item => item.id === saved.sourceId);
    if (!source) return report;
    return open(root, { assetPath: source.assetPath, sourceId: source.id, expectedAnalysis: analysis, expectedPrivateFiles: baseline.privateFiles, refreshEmpty: true }, dependencies);
  })().finally(() => openings.delete(root));
  openings.set(root, work); return work;
}
async function open(root, { assetPath, sourceId, expectedAnalysis, expectedPrivateFiles, refreshEmpty = false }, { registerSource, publication, discovery }) {
  const saved = await readSharedProjectOpen(root); if (saved && !refreshEmpty) return saved;
  const report = { readerRevision: 3, status: 'opening', imported: { transcription: 0, discovery: 0, analysis: 0 }, warnings: [], requestCount: 0 };
  const persist = async () => { await writeAtomic(fileFor(root), `${JSON.stringify({ version: 1, sourceId, sharedRead: report, ...(report.status === 'empty' ? { emptyBaseline: { analysisHash: sharedHash(expected), privateFiles: privateBefore } } : {}) }, null, 2)}\n`); return report; };
  let expected = expectedAnalysis;
  const privateBefore = expectedPrivateFiles ?? await privateFiles(root);
  const unchanged = async () => {
    const current = (await readProductAnalysis(root)).analysis;
    if (!expected || sharedHash(current) !== sharedHash(expected) || sharedHash(await privateFiles(root)) !== sharedHash(privateBefore)) throw changeError();
    return current;
  };
  try {
    await unchanged();
    if (hasSavedProductResult(expected, sourceId) || expected.sources.length !== 1) throw changeError();
    const prepared = await registerSource(root, { assetPath });
    // Probe can take seconds on network media. Its returned snapshot may also
    // contain a concurrent edit; only its duration field is ours to accept.
    const preparedSource = prepared.analysis.sources.find(item => item.id === sourceId);
    const durationOnly = structuredClone(expected);
    durationOnly.sources.find(item => item.id === sourceId).durationMs = preparedSource?.durationMs;
    if (sharedHash(prepared.analysis) !== sharedHash(durationOnly)) throw changeError();
    expected = durationOnly;
    const source = expected.sources.find(item => item.id === sourceId);
    if (!source || !Number.isFinite(source.durationMs) || source.durationMs <= 0) throw new HttpError(409, '视频时长未准备好，尚未查找共享结果');
    await persist();
    const { results } = await publication.catalog(root, sourceId);
    await unchanged();
    if (!results.length) { report.status = 'empty'; return persist(); }
    const request = row => ({ sourceId, taskKey: row.taskKey, resultSha: row.resultSha, action: row.action, scope: row.scope, confirmed: true });
    const singleton = (action, label) => {
      const matching = results.filter(row => row.action === action);
      if (matching.length > 1) report.warnings.push(`${label}有多个历史版本，请在已有分析记录中选择，未自动替换`);
      return matching.length === 1 ? matching[0] : null;
    };
    const transcript = singleton('transcription', '转写');
    if (transcript) {
      await unchanged();
      const imported = await publication.importResult(root, request(transcript));
      report.imported.transcription = transcript.count ?? 1;
      if (imported.needsReview) report.warnings.push('原始转写已读取，字幕接缝仍待核对；已有商品和历史话术可先查看');
    }
    const split = singleton('discovery', '商品拆分');
    if (split) {
      await unchanged();
      const imported = await publication.importResult(root, request(split));
      await unchanged();
      const applied = await discovery.apply(root, { sourceId, runId: imported.runId, expected, replaceReviewed: false });
      expected = applied?.analysis ?? (await readProductAnalysis(root)).analysis;
      report.imported.discovery = split.count ?? 1;
    }
    // Old publication files intentionally carried no product association. A
    // time overlap is not identity evidence: keep those candidates separate.
    const analyses = results.filter(row => row.action === 'analysis');
    const preferred = await publication.preferredResults?.(root, sourceId) ?? new Set();
    let historicalAnalyses = 0;
    for (const row of analyses) {
      const versions = analyses.filter(other => sharedHash(other.scope) === sharedHash(row.scope));
      if (versions.length > 1 && !preferred.has(row.resultSha)) {
        const warning = '同一话术范围有多个历史版本，请在已有分析记录中选择，未自动替换';
        if (!versions.some(other => preferred.has(other.resultSha)) && !report.warnings.includes(warning)) report.warnings.push(warning);
        continue;
      }
      await unchanged();
      const suffix = analyses.length > 1 ? ` ${Math.floor((row.scope?.startMs ?? 0) / 1000)}–${Math.ceil((row.scope?.endMs ?? 0) / 1000)}秒` : '';
      let imported;
      try {
        imported = await publication.importResult(root, { ...request(row), expectedAnalysis: expected, preservePrevious: versions.length > 1, productName: `已有话术（商品待核对）${suffix}` });
      } catch (error) {
        // A bad record must not hide unrelated completed work. If an import
        // changed the project before failing, or a user edited it, stop safely.
        await unchanged();
        report.warnings.push(`话术范围 ${suffix.trim() || row.taskKey} 未导入：${error.message}`);
        continue;
      }
      // Use the exact snapshot committed by the importer. A later user edit
      // must fail the next guard, never become the next automatic baseline.
      expected = imported.analysis;
      report.imported.analysis += row.count ?? 1;
      if (imported.needsReview && imported.reason && !report.warnings.includes(imported.reason)) report.warnings.push(imported.reason);
      if (row.provenance?.kind !== 'shared-workflow-v1') historicalAnalyses++;
    }
    await unchanged();
    if (publication.restoreCompositions) expected = (await publication.restoreCompositions(root, sourceId, expected)).analysis;
    await unchanged();
    if (publication.restoreLayout) {
      expected = (await publication.restoreLayout(root, sourceId)).analysis;
      if (expected.sharedLayouts?.[sourceId]) { historicalAnalyses = 0; report.warnings = report.warnings.filter(w => !/商品关联|独立分析范围|商品待核对/.test(w)); }
    }
    if (historicalAnalyses) report.warnings.push('历史话术未记录原商品关联，已完整显示为“已有话术（商品待核对）”；商品讲解边界保持原样');
    report.status = report.warnings.length ? 'review-required' : 'ready';
    return persist();
  } catch (error) {
    report.status = error.status === 409 ? 'review-required' : 'unavailable';
    report.warnings.push(`已有分析未全部接入：${error.message}。没有请求模型，可继续打开原片`);
    return persist();
  }
}
