import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSourceIssues, relevantExportSourceIssues } from './export-source-issues.ts';
import type { FilesListing } from './workspace-resources.ts';

const listing: FilesListing = {
  files: ['changed', 'unused', 'ready'].map(name => ({ path: `assets/${name}.mp4`, kind: 'video', size: 10, mtime: 1 })),
  folders: [], pages: [],
  links: Object.fromEntries([
    ['changed', 'needs-confirmation'], ['unused', 'offline'], ['ready', 'available'], ['unmapped', 'unconfigured'],
  ].map(([name, status]) => [`assets/${name}.mp4`, { to: '', source: { libraryId: 'test-library', libraryName: 'test', relativePath: `${name}.mp4`, size: 10, mtimeMs: 1, status } }])) as FilesListing['links'],
};

test('export distinguishes changed shared media from missing files, and keeps affected paths', () => {
  const issues = exportSourceIssues(listing, ['assets/changed.mp4', 'assets/unmapped.mp4', 'assets/ready.mp4']);
  assert.deepEqual(relevantExportSourceIssues(issues, 'video'), [
    { path: 'assets/changed.mp4', status: 'needs-confirmation', usedInFilm: true },
    { path: 'assets/unmapped.mp4', status: 'unconfigured', usedInFilm: true },
  ]);
});

test('unrelated unavailable sources do not block film export but do block project packing', () => {
  const issues = exportSourceIssues(listing, ['assets/ready.mp4']);
  for (const kind of ['video', 'audio', 'images', 'nle']) assert.deepEqual(relevantExportSourceIssues(issues, kind), []);
  assert.equal(relevantExportSourceIssues(issues, 'project').length, 3);
  assert.deepEqual(relevantExportSourceIssues(issues, 'subtitles'), []);
});

test('ordinary local sources and an absent listing do not invent shared failures', () => {
  assert.deepEqual(exportSourceIssues(null, ['assets/local.mp4']), []);
  assert.deepEqual(exportSourceIssues({ files: [], folders: [], pages: [] }, ['assets/local.mp4']), []);
});

test('single clip export checks its source while whole film and project retain their checks', () => {
  const issues = exportSourceIssues(listing, ['assets/changed.mp4', 'assets/local.mp4']);
  assert.deepEqual(relevantExportSourceIssues(issues, 'alpha', ['assets/local.mp4']), []);
  assert.equal(relevantExportSourceIssues(issues, 'alpha', ['assets/changed.mp4']).length, 1);
  assert.equal(relevantExportSourceIssues(issues, 'alpha').length, 1);
  assert.equal(relevantExportSourceIssues(issues, 'project', ['assets/local.mp4']).length, 3);
});
