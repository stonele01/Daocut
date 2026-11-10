import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowRight, Building2, CircleAlert, Clapperboard, Eye, EyeOff, FileKey2, LoaderCircle, LockKeyhole, Play, RefreshCw, ShieldAlert, SlidersHorizontal, Type, X } from 'lucide-react';
import { BrandLogo } from 'daocut/studio-ui/components/BrandLogo.tsx';
import { studioHost, type HostCompanyState } from 'daocut/studio-ui/lib/host.ts';
import './company.css';

const waveform = [7, 13, 18, 11, 23, 16, 9, 20, 25, 14, 19, 8, 13, 6];

/** Decorative only: all account state and access decisions still come from the host. */
function CompanyArtwork() {
  return <aside className="company-art-side">
    <div className="cg-brand cg-reveal">
      <BrandLogo size={32} /><span className="cg-wordmark">Daocut</span>
      <span className="cg-brand-divider" /><span className="cg-company">稻田科技</span>
    </div>
    <div className="cg-hero-copy cg-reveal">
      <div className="cg-eyebrow">A SPACE TO CREATE</div>
      <h2>把灵感，<br /><span>剪成好作品。</span></h2>
      <p>从一段素材，开始下一部作品</p>
    </div>
    <div className="cg-composition" aria-hidden="true">
      <div className="cg-art-shadow" />
      <div className="cg-film-back cg-layer" />
      <div className="cg-film-slice cg-layer" />
      <div className="cg-frame cg-layer">
        <span className="cg-frame-corner" />
        <div className="cg-play-disc"><Play /></div>
        <span className="cg-frame-time">00:00:12:08</span>
      </div>
      <div className="cg-text-clip cg-layer"><Type />每一帧，都有表达</div>
      <div className="cg-sound-clip cg-layer">
        {waveform.map((height, index) => <i key={index} style={{ height }} />)}
      </div>
      <div className="cg-timeline-art cg-layer">
        <div className="cg-clip" /><div className="cg-clip" /><div className="cg-clip" /><div className="cg-clip" />
        <div className="cg-playhead" />
      </div>
    </div>
    <div className="cg-art-footer cg-reveal"><Clapperboard size={14} aria-hidden="true" />你的创作，从这里继续</div>
  </aside>;
}

/** A company sign-in never unmounts projects or an ongoing render. Main checks every new AI request. */
export function CompanyGate() {
  const company = studioHost?.company;
  const [state, setState] = useState<HostCompanyState | null>(null);
  const [hadAccess, setHadAccess] = useState(false);
  // Local files remain usable during an outage; this never changes the host's authorization state.
  const [offlineAccess, setOfflineAccess] = useState(false);
  const [showLogin, setShowLogin] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showPasswordHelp, setShowPasswordHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [portal] = useState(() => document.createElement('div'));
  const panel = useRef<HTMLDivElement>(null);
  const connectionDialog = useRef<HTMLDialogElement>(null);
  const signedIn = state?.status === 'signed-in';
  const checking = !state || state.status === 'checking';
  const localAccess = hadAccess || offlineAccess;
  const locked = Boolean(company && !signedIn && (!localAccess || showLogin) && !(localAccess && checking && !showLogin));
  const [visible, setVisible] = useState(locked);

  useEffect(() => {
    if (!company) return;
    let alive = true;
    let updates = 0;
    const receive = (next: HostCompanyState) => {
      if (!alive) return;
      setState(next);
      if (!next.configured || !['unavailable', 'checking'].includes(next.status)) setOfflineAccess(false);
      if (next.status === 'signed-in') {
        setHadAccess(true); setShowLogin(false); setPassword(''); setShowPassword(false); setError('');
      }
    };
    const off = company.onChange((next) => { updates++; receive(next); });
    void company.state().then((next) => { if (!updates) receive(next); }).catch((failure) => {
      if (alive) setError(failure instanceof Error ? failure.message : '无法读取公司登录状态，请重试。');
    });
    return () => { alive = false; off(); };
  }, [company]);

  useEffect(() => {
    if (!company) return;
    portal.className = 'daocut-company-layer';
    document.body.append(portal);
    return () => { portal.remove(); };
  }, [company, portal]);

  useEffect(() => {
    if (locked) { setVisible(true); return; }
    connectionDialog.current?.close();
    setShowPassword(false);
    setShowPasswordHelp(false);
    const timer = setTimeout(() => setVisible(false), 180);
    return () => clearTimeout(timer);
  }, [locked]);

  useLayoutEffect(() => {
    if (!locked || !visible) return;
    const previousFocus = document.activeElement;
    const original = new Map<HTMLElement, boolean>();
    const cover = () => {
      for (const element of document.body.children) {
        if (!(element instanceof HTMLElement) || element === portal || original.has(element)) continue;
        original.set(element, element.inert);
        element.inert = true;
      }
    };
    cover();
    const observer = new MutationObserver(cover);
    observer.observe(document.body, { childList: true });
    panel.current?.focus();
    return () => {
      observer.disconnect();
      for (const [element, inert] of original) element.inert = inert;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [locked, visible, portal]);

  async function run(action: () => Promise<HostCompanyState>) {
    if (busy) return;
    setBusy(true); setError('');
    try { setState(await action()); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作未完成，请重试。'); }
    finally { setBusy(false); }
  }
  function login(event: FormEvent) {
    event.preventDefault();
    if (company) void run(() => company.login({ username: username.trim(), password }));
  }
  if (!company) return null;
  const message = error || state?.error;
  const configured = state?.configured ?? false;
  const title = checking ? '正在确认账号' : configured ? '登录你的创作空间' : '连接你的创作空间';
  const banner = localAccess && !signedIn && !checking && !locked;
  // Display the updated brand without changing connection profiles, URLs or tenant identities.
  const companyName = (state?.companyName || '稻田科技').replace(/^稻田公司(?:工作台)?$/, '稻田科技');
  const unavailable = state?.status === 'unavailable';
  const statusText = checking ? '正在连接' : unavailable ? '服务暂不可用' : configured ? '已配置连接' : '等待连接';

  return createPortal(<>
    {banner && <div className="company-notice" role="status">
      <ShieldAlert size={17} aria-hidden="true" />
      <span>{state?.status === 'unavailable' ? '暂时无法连接公司服务' : '公司账号需要重新登录'}，新 AI 和共享任务已暂停，本机工程可以继续查看、编辑和保存。</span>
      {unavailable && <button type="button" disabled={busy} onClick={() => void run(() => company.refresh())}>重新连接</button>}
      <button type="button" onClick={() => setShowLogin(true)}>重新登录</button>
    </div>}
    {visible && <div className="company-gate" data-open={locked} aria-hidden={!locked} inert={!locked}>
      <div className="company-window-handle" aria-hidden="true" />
      <div className="company-login-card" role="dialog" aria-modal="true" aria-labelledby="company-login-title"
        tabIndex={-1} ref={panel} onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key !== 'Tab' || connectionDialog.current?.open) return;
          const items = Array.from(panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled), a[href]') ?? [])
            .filter(element => element.getClientRects().length > 0 && !element.closest('[inert]'));
          const first = items[0], last = items.at(-1);
          if (!first) { event.preventDefault(); return; }
          if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel.current)) { event.preventDefault(); first.focus(); }
        }}>
        <CompanyArtwork />
        <section className="company-form-side" aria-label="公司账号登录">
          <div className="company-form-wrap">
            <div className="company-form-kicker">{configured ? '欢迎回来' : '开始创作'}</div>
            <h1 id="company-login-title">{title}</h1>
            <p className="company-lead">{configured ? '使用公司账号，继续今天的剪辑' : '导入管理员提供的连接文件，进入公司的 Daocut'}</p>
            <div className="company-connection-line">
              <span className="company-connection-name"><Building2 size={15} aria-hidden="true" />{companyName}</span>
              <span className="company-connection-status" data-unavailable={unavailable} role="status">
                {checking ? <LoaderCircle size={12} className="company-spin" aria-hidden="true" /> : <span className="company-status-dot" />}
                {statusText}
              </span>
            </div>
            {message && <div className="company-error" role="alert"><CircleAlert size={16} aria-hidden="true" /><p>{message}</p></div>}
            {checking && !busy && <div className="company-wait" role="status"><LoaderCircle size={19} className="company-spin" aria-hidden="true" />正在连接公司服务…</div>}
            {configured && <form onSubmit={login} className="company-login-form">
              <div className="company-field">
                <label htmlFor="company-username">员工账号</label>
                <input id="company-username" name="username" type="text" value={username} onChange={e => setUsername(e.target.value)}
                  autoComplete="username" maxLength={120} required disabled={busy} placeholder="请输入员工账号" spellCheck={false} />
              </div>
              <div className="company-field">
                <div className="company-label-row">
                  <label htmlFor="company-password">密码</label>
                  <button className="company-help-button" type="button" aria-expanded={showPasswordHelp} aria-controls="company-password-help"
                    onClick={() => setShowPasswordHelp(value => !value)}>忘记密码？</button>
                </div>
                <div className="company-password-wrap">
                  <input id="company-password" name="password" type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                    autoComplete="current-password" maxLength={1024} required disabled={busy} placeholder="请输入密码" />
                  <button type="button" className="company-eye-button" disabled={busy} aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword}
                    onClick={() => setShowPassword(value => !value)}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button>
                </div>
                <div className="company-password-help" id="company-password-help" data-open={showPasswordHelp} aria-hidden={!showPasswordHelp}>
                  <div><p>请联系公司管理员重置密码</p></div>
                </div>
              </div>
              <button className="company-primary" disabled={busy || !username.trim() || !password} type="submit">
                <span>{busy ? '正在连接…' : '登录'}</span>
                {busy ? <LoaderCircle size={17} className="company-spin" aria-hidden="true" /> : <ArrowRight size={17} aria-hidden="true" />}
              </button>
            </form>}
            {!configured && !checking && <button type="button" className="company-primary" disabled={busy} onClick={() => void run(() => company.importProfile())}>
              {busy ? <LoaderCircle size={17} className="company-spin" aria-hidden="true" /> : <FileKey2 size={18} aria-hidden="true" />} 导入公司连接文件
            </button>}
            <div className="company-login-actions">
              {(configured || (checking && message)) && <button type="button" disabled={busy} onClick={() => connectionDialog.current?.showModal()}>
                <SlidersHorizontal size={14} aria-hidden="true" />连接设置
              </button>}
              {localAccess && <button type="button" onClick={() => setShowLogin(false)}>返回本地项目</button>}
              {!localAccess && configured && unavailable && <button type="button" disabled={busy} onClick={() => { setOfflineAccess(true); setShowLogin(false); }}>离线打开本机工程</button>}
            </div>
            <p className="company-local-note"><LockKeyhole size={12} aria-hidden="true" />项目保存在本机，由你掌握</p>
          </div>
          <footer className="company-footer">Daocut {state?.appVersion || ''}</footer>
        </section>
        <dialog className="company-connection-dialog" ref={connectionDialog} aria-labelledby="company-connection-title">
          <div className="company-dialog-head">
            <h2 id="company-connection-title">公司连接</h2>
            <button type="button" className="company-dialog-close" aria-label="关闭连接设置" onClick={() => connectionDialog.current?.close()}><X size={18} /></button>
          </div>
          <p className="company-dialog-description">由管理员提供连接文件，将 Daocut 连接到公司的账号服务。</p>
          <div className="company-profile-summary"><FileKey2 size={24} aria-hidden="true" /><span><strong>{companyName}</strong><small>{configured ? '连接文件已配置' : '尚未配置连接文件'}</small></span></div>
          <div className="company-dialog-actions">
            <button type="button" disabled={busy} onClick={() => { connectionDialog.current?.close(); void run(() => company.importProfile()); }}><FileKey2 size={14} aria-hidden="true" />更换连接文件</button>
            {configured && <button type="button" className="company-dialog-primary" disabled={busy} onClick={() => { connectionDialog.current?.close(); void run(() => company.refresh()); }}><RefreshCw size={14} aria-hidden="true" />重新连接</button>}
          </div>
        </dialog>
      </div>
    </div>}
  </>, portal);
}
