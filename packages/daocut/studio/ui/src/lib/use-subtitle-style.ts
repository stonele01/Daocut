/**
 * The project's subtitle style: read from the project folder (`.film/subtitles.json`, via the server), written back
 * 500 ms after the last change. It is the person's look of this film, kept with the project and used by its exports,
 * and not in film.html, so an agent rewriting the film never resets it.
 *
 * A project whose style was never changed starts from the look this person used last (this browser remembers it,
 * see readLastSubtitleStyle), else the default; nothing is written for it until the person changes something.
 */
import * as React from 'react';
import { registerDraftFlush, trackDraftWrite } from './draft-save-barrier';
import { readSubtitleStyleRecovery, rememberSubtitleStyle, saveRememberedSubtitleStyle } from './subtitle-style-recovery';

import {
  fetchSubtitleStyle,
  readLastSubtitleStyle,
  saveSubtitleStyle,
  SUBTITLE_DEFAULT,
  writeLastSubtitleStyle,
  type SubtitleStyle,
} from './subtitles';

/** Dragging a color slider makes dozens of values: one write for all of them. */
const SAVE_DEBOUNCE_MS = 500;

const startingStyle = (): SubtitleStyle => readLastSubtitleStyle() ?? SUBTITLE_DEFAULT;

export function useSubtitleStyle(projectId: string): [SubtitleStyle, React.Dispatch<React.SetStateAction<SubtitleStyle>>] {
  const [style, setStyleState] = React.useState<SubtitleStyle>(() => readSubtitleStyleRecovery(projectId) ?? startingStyle());
  /* the JSON last known to match the project's file (null: not loaded yet; '': unknown, the next change is written) */
  const saved = React.useRef<string | null>(null);
  const styleRef = React.useRef(style);
  styleRef.current = style;
  const loading = React.useRef<Promise<void>>(Promise.resolve());
  const writes = React.useRef<Promise<unknown>>(Promise.resolve());

  React.useEffect(() => {
    saved.current = null;
    const recovered = readSubtitleStyleRecovery(projectId);
    const start = recovered ?? startingStyle();
    const startJson = JSON.stringify(start);
    styleRef.current = start;
    setStyleState(start);
    const ask = new AbortController();
    loading.current = fetchSubtitleStyle(projectId, ask.signal).then((kept) => {
      /* changed in the meantime: the person's change wins, and is written now */
      const dirty = recovered !== null || JSON.stringify(styleRef.current) !== startJson;
      if (!dirty) { styleRef.current = kept ?? start; setStyleState(kept ?? start); }
      saved.current = dirty ? '' : JSON.stringify(kept ?? start);
      if (dirty) setStyleState((s) => ({ ...s }));
    }, (error) => {
      if (!ask.signal.aborted) throw error;
    });
    void loading.current.catch(() => {});
    return () => ask.abort();
  }, [projectId]);

  const flush = React.useCallback(async () => {
    const write = writes.current.catch(() => {}).then(async () => {
      await loading.current;
      const nextStyle = styleRef.current, next = JSON.stringify(nextStyle);
      if (saved.current === null || next === saved.current) return;
      await trackDraftWrite(projectId, 'subtitle-style', saveRememberedSubtitleStyle(projectId, nextStyle, saveSubtitleStyle));
      saved.current = next;
      writeLastSubtitleStyle(nextStyle);
    });
    writes.current = write;
    await write;
  }, [projectId]);
  React.useEffect(() => registerDraftFlush(projectId, flush), [projectId, flush]);

  React.useEffect(() => {
    /* not loaded yet: writing now could overwrite the project's own style */
    if (saved.current === null) return undefined;
    const next = JSON.stringify(style);
    if (next === saved.current) return undefined;
    const timer = setTimeout(() => {
      flush().catch(() => {
        /* a failed save must not interrupt the person styling: the picture still shows their style, and the next
           change tries again */
        saved.current = '';
      });
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [projectId, style, flush]);

  const setStyle = React.useCallback<React.Dispatch<React.SetStateAction<SubtitleStyle>>>((update) => {
    const next = typeof update === 'function' ? update(styleRef.current) : update;
    // Keep the person's edit before returning from the event handler: a refresh can happen before any effect runs.
    rememberSubtitleStyle(projectId, next);
    styleRef.current = next;
    setStyleState(next);
  }, [projectId]);

  return [style, setStyle];
}
