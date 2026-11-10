import type { FilesListing, MediaLink } from './workspace-resources.ts';

export type ExportSourceIssue = {
  path: string;
  status: Exclude<NonNullable<MediaLink['source']>['status'], 'available'>;
  usedInFilm: boolean;
};

/** A changed source is not a missing filename: keep its reason visible before export. */
export function exportSourceIssues(listing: FilesListing | null, usedPaths: readonly string[]): ExportSourceIssue[] {
  const used = new Set(usedPaths);
  return Object.entries(listing?.links ?? {}).flatMap(([path, link]) => {
    const status = link.source?.status;
    return status && status !== 'available' ? [{ path, status, usedInFilm: used.has(path) }] : [];
  });
}

export function relevantExportSourceIssues(issues: readonly ExportSourceIssue[], destination: string, clipPaths?: readonly string[]): ExportSourceIssue[] {
  if (destination === 'subtitles') return [];
  return issues.filter(issue => destination === 'project' || (clipPaths ? clipPaths.includes(issue.path) : issue.usedInFilm));
}
