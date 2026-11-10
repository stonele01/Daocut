import React from 'react';
import { Building2, ExternalLink, FileUp, Loader2, LogOut, RefreshCw } from 'lucide-react';
import { useT } from '@/i18n';
import { studioHost, type HostCompanyState } from '@/lib/host';
import { SettingsButton, SettingsGroup, SettingsItem, SettingsPage, SettingsStatus } from './ui';

const BUTTON_MOTION = 'hover:scale-[1.02] active:scale-[0.98] motion-reduce:transform-none';

/** Company identity is separate from model credentials and projects, which stay on this computer. */
export function CompanySection() {
  const company = studioHost?.company;
  const t = useT();
  const words = (key: string) => t(`settings.company.${key}`);
  const [state, setState] = React.useState<HostCompanyState | null>(null);
  const acceptState = React.useCallback((next: HostCompanyState) => {
    setState(next);
  }, []);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (!company) return;
    let live = true;
    let received = false;
    const unsubscribe = company.onChange((next) => { received = true; if (live) acceptState(next); });
    void company.state().then((next) => { if (live && !received) acceptState(next); }, () => { if (live) setFailed(true); });
    return () => { live = false; unsubscribe(); };
  }, [company, acceptState]);
  if (!company) return null;
  const run = async (action: string, work: () => Promise<HostCompanyState | void>) => {
    setFailed(false);
    setBusy(action);
    try { const next = await work(); if (next) acceptState(next); }
    catch { setFailed(true); }
    finally { setBusy(null); }
  };
  const signedIn = state?.status === 'signed-in' && Boolean(state.user);
  const statuses: Record<HostCompanyState['status'], string> = {
    unconfigured: 'unconfigured', checking: 'checking', 'signed-out': 'signedOut', 'signed-in': 'signedIn', unavailable: 'unavailable',
  };
  const spinner = (action: string, icon: React.ReactNode) => busy === action ? <Loader2 size={14} className="animate-spin" aria-hidden /> : icon;
  return (
    <div className="company-settings">
      <style>{`@keyframes company-enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
        .company-settings { animation: company-enter 180ms ease both; }
        @media (prefers-reduced-motion: reduce) { .company-settings { animation: none; } }`}</style>
      <SettingsPage note={words('intro')}>
        <SettingsGroup title={words('account')} footnote={words('localData')}>
          <SettingsItem
            title={state?.user ? `${state.user.name} · ${state.user.username}` : state?.companyName || words('account')}
            mark={<Building2 size={18} aria-hidden />}
            badge={<SettingsStatus tone={signedIn ? 'ok' : 'muted'}>{state ? words(statuses[state.status]) : words('loading')}</SettingsStatus>}
            description={state ? `Daocut ${state.appVersion}` : undefined}
            control={(
              <>
                <SettingsButton disabled={Boolean(busy) || !state?.configured} onClick={() => void run('refresh', () => company.refresh())} className={BUTTON_MOTION}>
                  {spinner('refresh', <RefreshCw size={14} aria-hidden />)}{words('refresh')}
                </SettingsButton>
                {state?.configured && state.status !== 'signed-out' ? (
                  <SettingsButton disabled={Boolean(busy)} onClick={() => void run('logout', () => company.logout())} className={BUTTON_MOTION}>
                    {spinner('logout', <LogOut size={14} aria-hidden />)}{words('signOut')}
                  </SettingsButton>
                ) : null}
              </>
            )}
          />
          <SettingsItem title={words('connection')} description={state?.serverUrl || words('connectionHint')}
            control={(
              <SettingsButton disabled={Boolean(busy)} onClick={() => void run('import', () => company.importProfile())} className={BUTTON_MOTION}>
                {spinner('import', <FileUp size={14} aria-hidden />)}{words('importProfile')}
              </SettingsButton>
            )}
          />
          {signedIn && state?.user?.role === 'admin' ? (
            <SettingsItem title={words('administrator')}
              control={(
                <SettingsButton disabled={Boolean(busy)} onClick={() => void run('admin', () => company.openAdmin())} className={BUTTON_MOTION}>
                  {spinner('admin', <ExternalLink size={14} aria-hidden />)}{words('openAdmin')}
                </SettingsButton>
              )}
            />
          ) : null}
          {failed || state?.error ? <p role="alert" className="py-3 text-[13px] text-[var(--warn)]">{failed ? words('actionFailed') : state?.error}</p> : null}
        </SettingsGroup>
      </SettingsPage>
    </div>
  );
}
