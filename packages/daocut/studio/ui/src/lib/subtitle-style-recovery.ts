import type { SubtitleStyle } from './subtitles.ts';

type RecoveryStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const keyOf = (projectId: string) => `daocut.subtitle-style-recovery:${encodeURIComponent(projectId)}`;

/** A small local outbox, scoped to the exact private project, survives closing before the server debounce. */
export function readSubtitleStyleRecovery(projectId: string, storage?: RecoveryStorage): SubtitleStyle | null {
  try {
    const raw = (storage ?? localStorage).getItem(keyOf(projectId));
    if (!raw) return null;
    const record = JSON.parse(raw);
    return record.version === 1 && record.projectId === projectId && record.style && typeof record.style === 'object'
      ? record.style as SubtitleStyle : null;
  } catch { return null; }
}

/** Called in the change handler, before React renders or starts its 500 ms debounce. */
export function rememberSubtitleStyle(projectId: string, style: SubtitleStyle, storage?: RecoveryStorage): void {
  (storage ?? localStorage).setItem(keyOf(projectId), JSON.stringify({ version: 1, projectId, style }));
}

export function acknowledgeSubtitleStyle(projectId: string, style: SubtitleStyle, storage?: RecoveryStorage): void {
  if (JSON.stringify(readSubtitleStyleRecovery(projectId, storage)) === JSON.stringify(style)) {
    (storage ?? localStorage).removeItem(keyOf(projectId));
  }
}

/** Only a confirmed write can clear recovery, and a newer edit made during that write remains pending. */
export async function saveRememberedSubtitleStyle(projectId: string, style: SubtitleStyle,
  save: (projectId: string, style: SubtitleStyle) => Promise<void>, storage?: RecoveryStorage): Promise<void> {
  await save(projectId, style);
  acknowledgeSubtitleStyle(projectId, style, storage);
}
