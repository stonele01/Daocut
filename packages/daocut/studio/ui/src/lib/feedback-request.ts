import type { StudioProblem } from '@/api';

export const FEEDBACK_REQUEST = 'daocut-feedback-request';
let lastProblem: StudioProblem | null = null;
let pending: StudioProblem | null = null;

export function rememberFeedbackProblem(what: string, area = 'editor') {
  lastProblem = { t: new Date().toISOString(), area, what, step: window.location.pathname };
}

/** Opens the existing company feedback form. Only its Send button submits. */
export function requestFeedback(what?: string, area?: string) {
  if (what) rememberFeedbackProblem(what, area);
  pending = lastProblem ? { ...lastProblem } : null;
  window.dispatchEvent(new Event(FEEDBACK_REQUEST));
}

export function takeFeedbackProblem() {
  const value = pending;
  pending = null;
  return value;
}
