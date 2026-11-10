import React from 'react';
import { createRoot } from 'react-dom/client';
import type { HostCompanyState, HostCompanyFeedback, HostCompanyFeedbackInput } from '../../../studio/ui/src/lib/host';

// Real FeedbackSection, synthetic host bridge and diagnostic API only. Never contacts an account or model.
localStorage.setItem('daocut.language', 'en');
const serverUrl = 'https://company.invalid';
const user = (id: string) => ({ id, username: id, name: id, role: 'employee' });
let current: HostCompanyState = { configured: true, status: 'signed-in', serverUrl, user: user('employee-a'), appVersion: 'test' };
const listeners = new Set<(state: HostCompanyState) => void>();
let records: HostCompanyFeedback[] = [];
let posts: HostCompanyFeedbackInput[] = [];
let pendingPost: { resolve: (result: { feedback: HostCompanyFeedback }) => void; reject: (error: Error) => void; input: HostCompanyFeedbackInput } | null = null;
let collectPaused = false;
let pendingReport: ((value: { ok: boolean; text: string }) => void) | null = null;
let reportCalls = 0;
const company = {
  state: async () => current,
  onChange: (listener: (state: HostCompanyState) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  feedback: async () => ({ feedback: records.filter((item) => item.userId === current.user?.id) }),
  feedbackDetails: async (id: string) => ({ feedback: records.find((item) => item.id === id)! }),
  submitFeedback: (input: HostCompanyFeedbackInput) => {
    if (current.status !== 'signed-in' || current.user?.id !== input.identity.userId || current.serverUrl !== input.identity.serverUrl) throw new Error('wrong-owner');
    posts.push(input);
    return new Promise<{ feedback: HostCompanyFeedback }>((resolve, reject) => { pendingPost = { resolve, reject, input }; });
  },
};
(window as any).daocutHost = { version: 1, name: 'Daocut', company };
const { api } = await import('../../../studio/ui/src/api');
Object.assign(api, {
  doctor: async () => { reportCalls++; return collectPaused ? new Promise((resolve) => { pendingReport = resolve; }) : { ok: true, text: 'Synthetic report' }; },
  problems: async () => [],
  feedbackDiagnostics: async () => ({ details: 'Synthetic details' }),
});
const { FeedbackSection } = await import('../../../studio/ui/src/components/settings/FeedbackSection');
const root = createRoot(document.getElementById('root')!);
root.render(<FeedbackSection />);
(window as any).feedbackTest = {
  change(status: HostCompanyState['status'], userId = 'employee-a', targetServer = serverUrl) {
    current = { configured: true, status, serverUrl: targetServer, ...(status === 'signed-in' ? { user: user(userId) } : {}), appVersion: 'test' };
    for (const listener of listeners) listener(current);
  },
  pauseCollection() { collectPaused = true; },
  releaseCollection() { if (!pendingReport) throw new Error('no pending report'); pendingReport({ ok: true, text: 'Synthetic report' }); pendingReport = null; },
  resolvePost() {
    if (!pendingPost) throw new Error('no pending post');
    const { input, resolve } = pendingPost;
    const item = { ...input, userId: input.identity.userId, id: `feedback-${posts.length}`, status: 'new', createdAt: '2026-10-24T09:00:00Z' };
    records.push(item); pendingPost = null; resolve({ feedback: item });
  },
  rejectPost() { if (!pendingPost) throw new Error('no pending post'); const { reject } = pendingPost; pendingPost = null; reject(new Error('Synthetic request failure')); },
  inspect: () => ({ posts, records, pending: Boolean(pendingPost), pendingReport: Boolean(pendingReport), reportCalls, status: current.status }),
  unmount() { root.unmount(); },
};
