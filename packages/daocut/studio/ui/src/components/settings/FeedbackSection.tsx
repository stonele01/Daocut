import React from 'react';
import { ChevronDown, ImagePlus, Loader2, RefreshCw, Send, X } from 'lucide-react';
import { useLanguage, useT } from '@/i18n';
import { api, type StudioProblem } from '@/api';
import { feedbackReport } from '@/lib/feedback-report';
import { limitFeedbackText } from '@/lib/feedback-text';
import { studioHost, type HostCompany, type HostCompanyFeedback, type HostCompanyState, type HostFeedbackAttachmentInput, type HostFeedbackDiagnostics } from '@/lib/host';
import { DiagnosticsGroup, makeReport } from './DiagnosticsGroup';
import { SettingsSelect } from './SettingsSelect';
import { SettingsButton, SettingsGroup, SettingsPage, SettingsSwitch } from './ui';

const MOTION = 'hover:scale-[1.02] active:scale-[0.98] motion-reduce:transform-none';
const FIELD = 'w-full rounded-[8px] border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[14px] text-[var(--text)] outline-none transition focus:border-[var(--text-muted)] focus:ring-2 focus:ring-[var(--fill-tsp)] disabled:opacity-60';
type Category = 'bug' | 'suggestion' | 'other';

function Disclosure({ title, children, startOpen = false }: { title: string; children: React.ReactNode; startOpen?: boolean }) {
  const [open, setOpen] = React.useState(startOpen);
  const id = React.useId();
  return <div className="rounded-[9px] border border-[var(--border)]">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}
      className="flex w-full items-center justify-between gap-3 rounded-[9px] px-3 py-2.5 text-left text-[13.5px] text-[var(--text)] transition hover:bg-[var(--bg-hover)]">
      {title}<ChevronDown size={15} aria-hidden className={`shrink-0 transition-transform duration-200 motion-reduce:transition-none ${open ? 'rotate-180' : ''}`} />
    </button>
    <div id={id} inert={!open} className={`grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}>
      <div className="min-h-0 overflow-hidden"><div className="border-t border-[var(--border)] p-3">{children}</div></div>
    </div>
  </div>;
}

function DiagnosticText({ diagnostics }: { diagnostics: HostFeedbackDiagnostics }) {
  return <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[7px] bg-[var(--surface-2)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--text-muted)]">{[diagnostics.report, diagnostics.details].filter(Boolean).join('\n\n')}</pre>;
}

/** One support page: authenticated feedback when available, local reports in every Studio. */
export function FeedbackSection() {
  const t = useT();
  const company = studioHost?.company;
  const [state, setState] = React.useState<HostCompanyState | null>(null);
  const [problem, setProblem] = React.useState<StudioProblem | null>(null);
  const [identity, setIdentity] = React.useState<{ serverUrl: string; userId: string } | null>(null);
  React.useEffect(() => {
    if (!company) return;
    let live = true;
    let received = false;
    const accept = (next: HostCompanyState) => {
      if (!live) return;
      setState(next);
      setIdentity((previous) => next.status === 'signed-in' && next.user
        ? { serverUrl: next.serverUrl ?? '', userId: next.user.id }
        : (next.status === 'checking' || next.status === 'unavailable') && previous?.serverUrl === next.serverUrl ? previous : null);
    };
    const unsubscribe = company.onChange((next) => { received = true; accept(next); });
    void company.state().then((next) => { if (!received) accept(next); }, () => {});
    return () => { live = false; unsubscribe(); };
  }, [company]);
  const signedIn = state?.status === 'signed-in' && Boolean(state.user);
  return <div className="feedback-settings">
    <style>{`@keyframes feedback-enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
      .feedback-settings { animation: feedback-enter 180ms ease both; }
      @media (prefers-reduced-motion: reduce) { .feedback-settings { animation: none; } }`}</style>
    <SettingsPage note={t('settings.feedback.intro')}>
      {!signedIn ? <p className="mb-5 rounded-[9px] bg-[var(--surface-2)] p-3 text-[13.5px] leading-relaxed text-[var(--text-muted)]">{t(company ? 'settings.feedback.login' : 'settings.feedback.localOnly')}</p> : null}
      {company && identity ? <FeedbackForm key={`${identity.serverUrl}:${identity.userId}`} company={company} owner={identity} enabled={signedIn} selectedProblem={problem} /> : null}
      <Disclosure title={t('settings.feedback.more')} startOpen={!company}><DiagnosticsGroup onProblemSelect={signedIn ? (item) => setProblem({ ...item }) : undefined} /></Disclosure>
    </SettingsPage>
  </div>;
}

function readScreenshot(file: File): Promise<HostFeedbackAttachmentInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read-failed'));
    reader.onload = () => {
      if (typeof reader.result !== 'string' || !reader.result.includes(',')) return reject(new Error('read-failed'));
      resolve({ name: file.name, mimeType: file.type, data: reader.result.slice(reader.result.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}

/** Only an explicit Send submits content; previews are collected locally and kept until submission succeeds. */
function FeedbackForm({ company, owner, enabled, selectedProblem }: { company: HostCompany; owner: { serverUrl: string; userId: string }; enabled: boolean; selectedProblem: StudioProblem | null }) {
  const userId = owner.userId;
  const mounted = React.useRef(false);
  const latestEnabled = React.useRef(enabled);
  latestEnabled.current = enabled;
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const t = useT();
  const language = useLanguage();
  const words = (key: string) => t(`settings.company.${key}`);
  const feedbackWords = (key: string) => t(`settings.feedback.${key}`);
  const formId = React.useId();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [category, setCategory] = React.useState<Category>('bug');
  const [title, setTitle] = React.useState('');
  const [description, setDescription] = React.useState('');
  React.useEffect(() => {
    if (!selectedProblem) return;
    const problemText = [selectedProblem.t, [selectedProblem.agent ?? selectedProblem.area, selectedProblem.step].filter(Boolean).join(' · '), selectedProblem.what].join('\n');
    setCategory('bug');
    setTitle((previous) => previous || limitFeedbackText(selectedProblem.what.split(/\r?\n/)[0]!, 120));
    setDescription((previous) => previous.includes(problemText) ? previous : limitFeedbackText([problemText, previous].filter(Boolean).join('\n\n'), 8000));
    document.getElementById(formId + '-title')?.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    document.getElementById(formId + '-title')?.focus({ preventScroll: true });
  }, [selectedProblem, formId]);
  const [includeReport, setIncludeReport] = React.useState(true);
  const [includeDetails, setIncludeDetails] = React.useState(false);
  const [diagnostics, setDiagnostics] = React.useState<HostFeedbackDiagnostics | null>(null);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [attachments, setAttachments] = React.useState<HostFeedbackAttachmentInput[]>([]);
  const [filesBusy, setFilesBusy] = React.useState(false);
  const [fileError, setFileError] = React.useState(false);
  const [preparing, setPreparing] = React.useState(false);
  const [diagnosticFailed, setDiagnosticFailed] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [submission, setSubmission] = React.useState<'idle' | 'sent' | 'failed'>('idle');
  const [items, setItems] = React.useState<HostCompanyFeedback[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [reload, setReload] = React.useState(0);
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [detailLoading, setDetailLoading] = React.useState<string | null>(null);
  const [detailFailed, setDetailFailed] = React.useState<string | null>(null);
  const busy = submitting || preparing || filesBusy;
  React.useEffect(() => {
    if (!enabled) return;
    let live = true;
    setLoading(true); setLoadFailed(false);
    void company.feedback().then((result) => { if (live) setItems(result.feedback.filter((item) => item.userId === userId)); }, () => { if (live) setLoadFailed(true); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [company, reload, enabled, userId]);
  const invalidateDiagnostics = () => { setDiagnostics(null); setPreviewOpen(false); setDiagnosticFailed(false); };
  const collect = async (): Promise<HostFeedbackDiagnostics> => {
    if (diagnostics) return diagnostics;
    setPreparing(true); setDiagnosticFailed(false);
    try {
      const [report, problems, detailed] = await Promise.all([makeReport(), api.problems(), includeDetails ? api.feedbackDiagnostics(true) : null]);
      const result = { report: feedbackReport(report, problems), ...(detailed ? { details: detailed.details } : {}) };
      setDiagnostics(result);
      return result;
    } catch (error) { setDiagnosticFailed(true); throw error; }
    finally { setPreparing(false); }
  };
  const preview = async () => { try { await collect(); setPreviewOpen(true); } catch { /* shown beside controls */ } };
  const addFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    const selected = Array.from(list);
    setFileError(false);
    if (selected.length + attachments.length > 3 || selected.some((file) => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024 || file.size === 0)) { setFileError(true); return; }
    setFilesBusy(true);
    try { const ready = await Promise.all(selected.map(readScreenshot)); setAttachments((previous) => [...previous, ...ready]); }
    catch { setFileError(true); }
    finally { setFilesBusy(false); }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!enabled || busy || !title.trim() || !description.trim()) return;
    setSubmitting(true); setSubmission('idle');
    try {
      const report = includeReport ? await collect() : undefined;
      // Collection may finish after logout/account change. Never submit another employee's draft.
      if (!mounted.current || !latestEnabled.current) return;
      const result = await company.submitFeedback({ identity: { ...owner }, category, title: title.trim(), description: description.trim(), ...(report ? { diagnostics: report } : {}), ...(attachments.length ? { attachments } : {}) });
      // This form is keyed by company/user and unmounts when that identity changes. A temporary
      // connection failure must not discard an already accepted submission for the same owner.
      if (!mounted.current) return;
      setItems((previous) => [result.feedback, ...previous.filter((item) => item.id !== result.feedback.id)]);
      setExpanded(null); setTitle(''); setDescription(''); setCategory('bug');
      setAttachments([]); setFileError(false); setIncludeReport(true); setIncludeDetails(false); invalidateDiagnostics();
      setSubmission('sent');
    } catch { setSubmission('failed'); }
    finally { setSubmitting(false); }
  };
  const expand = async (item: HostCompanyFeedback) => {
    if (expanded === item.id) { setExpanded(null); return; }
    setExpanded(item.id); setDetailFailed(null);
    if (!item.hasDiagnostics || item.diagnostics) return;
    setDetailLoading(item.id);
    try {
      const result = await company.feedbackDetails(item.id);
      if (!mounted.current || !latestEnabled.current) return;
      if (result.feedback.userId !== userId) throw new Error('different-owner');
      setItems((previous) => previous.map((old) => old.id === item.id ? result.feedback : old));
    } catch { setDetailFailed(item.id); }
    finally { setDetailLoading((previous) => previous === item.id ? null : previous); }
  };
  const date = (value?: string) => {
    if (!value) return '';
    const at = new Date(value);
    return Number.isNaN(at.getTime()) ? '' : at.toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
  };
  const categories = ['bug', 'suggestion', 'other'] as const;
  const statuses = ['new', 'in_progress', 'resolved', 'closed'];
  return <>
    <SettingsGroup title={words('feedback')}>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={!enabled || busy} className="flex min-w-0 flex-col gap-4 border-0 py-4">
          <div className="flex items-center justify-between gap-4"><span className="text-[14px] text-[var(--text)]">{words('category')}</span>
            <SettingsSelect<Category> label={words('category')} value={category} onChange={setCategory} options={categories.map((value) => ({ value, label: words(`categories.${value}`) }))} />
          </div>
          <label htmlFor={`${formId}-title`} className="flex flex-col gap-2 text-[14px] text-[var(--text)]">
            <span className="flex justify-between gap-3"><span>{words('title')}</span><span className="tabular-nums text-[var(--text-faint)]">{title.length}/120</span></span>
            <input id={`${formId}-title`} className={FIELD} value={title} onChange={(event) => { setTitle(event.target.value); setSubmission('idle'); }} required maxLength={120} placeholder={words('titlePlaceholder')} />
          </label>
          <label htmlFor={`${formId}-description`} className="flex flex-col gap-2 text-[14px] text-[var(--text)]">
            <span className="flex justify-between gap-3"><span>{words('description')}</span><span className="tabular-nums text-[var(--text-faint)]">{description.length}/8000</span></span>
            <textarea id={`${formId}-description`} className={`${FIELD} min-h-28 resize-y`} value={description} onChange={(event) => { setDescription(event.target.value); setSubmission('idle'); }} required maxLength={8000} rows={4} placeholder={words('descriptionPlaceholder')} />
          </label>
          <div className="rounded-[9px] border border-[var(--border)] p-3.5">
            <div className="flex items-center justify-between gap-4"><div><p className="text-[14px] text-[var(--text)]">{feedbackWords('attachReport')}</p><p className="mt-1 text-[12.5px] leading-relaxed text-[var(--text-muted)]">{feedbackWords('reportHint')}</p></div>
              <SettingsSwitch label={feedbackWords('attachReport')} checked={includeReport} onChange={(value) => { setIncludeReport(value); if (!value) setIncludeDetails(false); invalidateDiagnostics(); }} />
            </div>
            {includeReport ? <div className="mt-4 space-y-3 border-t border-[var(--border)] pt-3">
              <div className="flex items-center justify-between gap-4"><div><p className="text-[13.5px] text-[var(--text)]">{feedbackWords('attachDetails')}</p><p className="mt-1 text-[12px] leading-relaxed text-[var(--text-muted)]">{feedbackWords('detailsHint')}</p></div>
                <SettingsSwitch label={feedbackWords('attachDetails')} checked={includeDetails} onChange={(value) => { setIncludeDetails(value); invalidateDiagnostics(); }} />
              </div>
              <SettingsButton onClick={() => void preview()} className={MOTION}>{feedbackWords('preview')}</SettingsButton>
              {diagnostics && previewOpen ? <DiagnosticText diagnostics={diagnostics} /> : null}
            </div> : null}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3"><div><p className="text-[14px] text-[var(--text)]">{feedbackWords('screenshots')}</p><p className="mt-1 text-[12px] text-[var(--text-muted)]">{feedbackWords('screenshotsHint')}</p></div>
              <SettingsButton disabled={attachments.length >= 3} onClick={() => fileInput.current?.click()} className={MOTION}><ImagePlus size={14} aria-hidden />{feedbackWords('addScreenshot')}</SettingsButton>
            </div>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple className="hidden" aria-label={feedbackWords('addScreenshot')} onChange={(event) => { void addFiles(event.target.files); event.target.value = ''; }} />
            {attachments.length ? <ul className="flex flex-wrap gap-2">{attachments.map((file, index) => <li key={`${index}:${file.name}`} className="flex min-w-0 max-w-full items-center gap-2 rounded-[8px] border border-[var(--border)] p-2">
              <img src={`data:${file.mimeType};base64,${file.data}`} alt="" className="h-10 w-12 rounded object-cover" /><span className="max-w-48 truncate text-[12px] text-[var(--text-muted)]">{file.name}</span>
              <button type="button" aria-label={`${feedbackWords('removeScreenshot')} ${file.name}`} className="rounded p-1 text-[var(--text-muted)] transition hover:bg-[var(--bg-hover)]" onClick={() => { setAttachments((previous) => previous.filter((_, i) => i !== index)); setFileError(false); }}><X size={14} /></button>
            </li>)}</ul> : null}
            {fileError ? <p role="alert" className="text-[12.5px] text-[var(--warn)]">{feedbackWords('screenshotError')}</p> : null}
          </div>
          <div className="flex items-center justify-between gap-4">
            <p role={submission === 'failed' || diagnosticFailed ? 'alert' : 'status'} className={`text-[13px] ${submission === 'failed' || diagnosticFailed ? 'text-[var(--warn)]' : 'text-[var(--text-muted)]'}`}>
              {diagnosticFailed ? feedbackWords('diagnosticFailed') : submission === 'sent' ? words('sent') : submission === 'failed' ? words('submitFailed') : preparing ? feedbackWords('preparing') : ''}
            </p>
            <SettingsButton type="submit" variant="primary" disabled={busy || !title.trim() || !description.trim()} className={MOTION}>
              {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}{submitting ? words('submitting') : feedbackWords('send')}
            </SettingsButton>
          </div>
        </fieldset>
      </form>
    </SettingsGroup>
    <SettingsGroup title={words('history')}>
      <div className="flex items-center justify-between gap-4 py-3"><p role="status" className={`text-[13.5px] ${loadFailed ? 'text-[var(--warn)]' : 'text-[var(--text-muted)]'}`}>{loading ? words('loading') : loadFailed ? words('loadFailed') : !items.length ? words('noFeedback') : ''}</p>
        <SettingsButton disabled={!enabled || loading || busy} onClick={() => setReload((value) => value + 1)} className={MOTION}><RefreshCw size={14} aria-hidden className={loading ? 'animate-spin' : ''} />{words('refresh')}</SettingsButton>
      </div>
      <ul className="flex flex-col gap-2 pt-2">{items.map((item, index) => {
        const open = expanded === item.id;
        const detailId = `${formId}-history-${index}`;
        const status = item.status && statuses.includes(item.status) ? words(`feedbackStatus.${item.status}`) : words('unknownStatus');
        const adminNote = typeof item.adminNote === 'string' ? item.adminNote : '';
        return <li key={item.id} className="overflow-hidden rounded-[9px] border border-[var(--border)] transition-colors hover:border-[var(--border-strong)]">
          <button type="button" aria-expanded={open} aria-controls={detailId} onClick={() => void expand(item)} className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition hover:bg-[var(--bg-hover)] active:scale-[0.995] motion-reduce:transform-none">
            <span className="min-w-0 flex-1"><span className="block break-words text-[14px] text-[var(--text)]">{item.title}</span><span className="mt-1 block text-[12px] text-[var(--text-muted)]">{words(`categories.${categories.includes(item.category as Category) ? item.category : 'other'}`)} · {date(item.createdAt)}</span></span>
            <span className="shrink-0 rounded-full bg-[var(--fill-tsp)] px-2 py-1 text-[12px] text-[var(--text-muted)]">{status}</span><ChevronDown size={15} aria-hidden className={`shrink-0 text-[var(--text-muted)] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
          </button>
          <div id={detailId} inert={!open} className={`grid transition-[grid-template-rows,opacity] duration-200 motion-reduce:transition-none ${open ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}><div className="min-h-0 overflow-hidden"><div className="space-y-3 border-t border-[var(--border)] px-3.5 py-3 text-[13.5px] leading-relaxed">
            <p className="whitespace-pre-wrap break-words text-[var(--text-muted)]">{item.description}</p>
            {adminNote ? <div className="rounded-[7px] bg-[var(--fill-tsp)] p-3"><p className="mb-1 font-medium text-[var(--text)]">{words('adminNote')}</p><p className="whitespace-pre-wrap break-words text-[var(--text-muted)]">{adminNote}</p></div> : null}
            {detailLoading === item.id ? <p className="text-[var(--text-muted)]">{words('loading')}</p> : null}
            {detailFailed === item.id ? <p role="alert" className="text-[var(--warn)]">{words('loadFailed')}</p> : null}
            {item.diagnostics ? <Disclosure title={feedbackWords('sentDiagnostics')}><DiagnosticText diagnostics={item.diagnostics} /></Disclosure> : null}
            {item.attachments?.length ? <p className="break-words text-[12.5px] text-[var(--text-muted)]">{feedbackWords('screenshots')} · {item.attachments.map((file) => file.name).join('、')}</p> : null}
          </div></div></div>
        </li>;
      })}</ul>
    </SettingsGroup>
  </>;
}
