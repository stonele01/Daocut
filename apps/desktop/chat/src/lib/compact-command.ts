import { splitPromptReferenceText } from '@daocut/shared';

/** A bundled session command cannot carry a prompt or join a running model turn. */
export function compactPromptBlocker({ agent, text, attachmentCount, active }: {
  agent: string; text: string; attachmentCount: number; active: boolean;
}): 'composer.compactStandalone' | 'composer.compactBusy' | null {
  if (agent !== 'byok') return null;
  const segments = splitPromptReferenceText(text);
  const plain = segments.filter((part) => part.kind === 'text').map((part) => part.value).join('').trim();
  if (!/^\/compact(?:\s|$)/.test(plain)) return null;
  if (plain !== '/compact' || attachmentCount > 0 || segments.some((part) => part.kind === 'reference')) {
    return 'composer.compactStandalone';
  }
  return active ? 'composer.compactBusy' : null;
}
