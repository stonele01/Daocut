/**
 * The window of an app with tabs (lib/host.ts `tabs`) when no tab is open: an empty window (its top bar still drags
 * it) and the projects window over it, as `+` opens it, only with nothing behind to close it to. The project picked
 * opens in its tab. Shown while tabs are open too (a tab's page that could not load), its top bar has them, so they
 * can always be reached.
 */
import { BrandLogo } from './BrandLogo';
import { ProjectsPopover } from './ProjectsLibrary';
import { SettingsModal } from './settings/SettingsModal';
import { TabStrip, useHostTabs } from './TabStrip';
import { useSettings } from './settings/use-settings';
import { Tooltip } from './Tooltip';
import { useT } from '@/i18n';

export function Launcher({ onOpen }: { onOpen: (projectId: string) => void }) {
  const t = useT();
  const [settings, setSettings] = useSettings();
  const { tabs } = useHostTabs();
  return (
    <div className="workspace-shell flex flex-col bg-[var(--dock-shell)]">
      <div data-titlebar className="relative flex h-8 min-w-0 shrink-0 items-center gap-1 px-[6px]">
        <div aria-hidden className="shrink-0 self-stretch" style={{ width: 'var(--titlebar-logo-x)' }} />
        <Tooltip label={t('project.appMenu')} side="bottom">
          <button type="button" aria-label={t('project.appMenu')} aria-haspopup="dialog" onClick={() => setSettings('general')}
            className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-md text-[var(--text-dim)] transition hover:bg-[var(--bg-hover)]">
            <BrandLogo size={15} />
          </button>
        </Tooltip>
        {tabs.length ? <TabStrip /> : null}
      </div>
      <ProjectsPopover open currentProjectId="" onOpen={onOpen} onCurrentRemoved={() => {}} />
      <SettingsModal open={settings !== null} section={settings ?? undefined} onClose={() => setSettings(null)} />
    </div>
  );
}
