export interface ProjectBackupInspection {
  backupId: string;
  name: string;
  fileCount: number;
  hasPendingResults: boolean;
  libraries: { id: string; name: string }[];
  sources: { sourceId: string; assetPath: string; durationMs: number; sha256: string; size: number; libraryId?: string; libraryName?: string; relativePath?: string }[];
}
export interface ProjectBackupRestoreInput {
  backupPath: string;
  targetPath: string;
  expectedBackupId: string;
  confirmed: true;
  mappings: { libraryId: string; root: string }[];
  resultRoots?: { libraryId: string; root: string }[];
}
