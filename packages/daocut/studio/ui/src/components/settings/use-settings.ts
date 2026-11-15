import React from 'react';
import { studioHost } from '../../lib/host';
import type { SettingsSection } from './SettingsModal';
import { FEEDBACK_REQUEST } from '@/lib/feedback-request';

/** Both editor and launcher follow the native Settings command; each page has its own dialog. */
export function useSettings() {
  const [section, setSection] = React.useState<SettingsSection | null>(null);
  React.useEffect(() => studioHost?.settings?.onOpen(() => setSection('general')), []);
  React.useEffect(() => {
    const openFeedback = () => setSection('feedback');
    window.addEventListener(FEEDBACK_REQUEST, openFeedback);
    return () => window.removeEventListener(FEEDBACK_REQUEST, openFeedback);
  }, []);
  return [section, setSection] as const;
}
