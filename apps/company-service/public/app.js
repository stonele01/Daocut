const app = document.querySelector('#app');
const notice = document.querySelector('#notice');
const shanghaiToday = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const state = { user: null, setup: false, users: [], feedback: [], tab: 'users', filter: 'all', usage: null, usageLoading: false, usageError: '', quotas: [], quotaLoading: false, quotaError: '', usageFilters: { from: `${shanghaiToday().slice(0, 7)}-01`, to: shanghaiToday(), userId: '', model: '' } };
const statusLabels = { new: '待处理', in_progress: '处理中', resolved: '已解决', closed: '已关闭' };
const categoryLabels = { bug: '问题反馈', suggestion: '改进建议', other: '其他' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const brand = '<div class="brand"><img class="brand-mark" src="/brand.svg" alt="稻田标志" width="42" height="42"><div><strong>Daocut</strong><small>公司管理台</small></div></div>';
let toastTimer;
function toast(message) { notice.textContent = message; notice.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => notice.classList.remove('visible'), 4000); }
async function api(route, { method = 'GET', body } = {}) {
  const response = await fetch(`/api/company${route}`, { method, credentials: 'same-origin', headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && state.user) { clearUsage(); state.user = null; state.users = []; state.feedback = []; render(); } throw new Error(result.error?.message || '操作未完成'); }
  return result;
}
let activeTransition;
function swap(markup) {
  const update = () => { app.innerHTML = markup; };
  if (!document.startViewTransition) return update();
  activeTransition?.skipTransition();
  activeTransition = document.startViewTransition(update);
  activeTransition.ready.catch(() => {});
  activeTransition.finished.catch(() => {});
}
function render() {
  if (!state.user) {
    swap(`<main class="auth-layout"><section class="auth-card">${brand}<h1>${state.setup ? '创建首位管理员' : '欢迎回来'}</h1><p>${state.setup ? '在这台电脑完成初始设置。账号与反馈数据保存在公司服务的数据目录中。' : '登录以管理公司账号或查看反馈进度。'}</p><form data-form="${state.setup ? 'setup' : 'login'}">${state.setup ? '<div class="field"><label for="name">姓名</label><input id="name" name="name" required maxlength="80" autocomplete="name"></div>' : ''}<div class="field"><label for="username">账号</label><input id="username" name="username" required minlength="3" maxlength="32" autocomplete="username" placeholder="例如 zhangsan" pattern="[A-Za-z0-9][A-Za-z0-9._-]*"></div><div class="field"><label for="password">密码</label><input id="password" name="password" type="password" required minlength="10" maxlength="128" autocomplete="${state.setup ? 'new-password' : 'current-password'}">${state.setup ? '<small>至少 10 个字符，请使用独立密码</small>' : ''}</div><div class="form-error" role="alert"></div><button class="primary" type="submit">${state.setup ? '创建管理员' : '登录'}</button></form></section></main>`);
    return;
  }
  const admin = state.user.role === 'admin';
  const pending = state.feedback.filter((item) => ['new', 'in_progress'].includes(item.status)).length;
  const title = state.tab === 'users' ? '员工账号' : state.tab === 'usage' ? (admin ? '员工 Token 管理' : '我的 Token 用量') : admin ? '反馈收件箱' : '我的反馈';
  swap(`<div class="shell"><aside class="sidebar">${brand}<nav class="nav" aria-label="管理导航">${admin ? `<button data-tab="users" class="${state.tab === 'users' ? 'active' : ''}">员工账号</button>` : ''}<button data-tab="feedback" class="${state.tab === 'feedback' ? 'active' : ''}">${admin ? '反馈收件箱' : '我的反馈'}</button><button data-tab="usage" class="${state.tab === 'usage' ? 'active' : ''}">${admin ? 'Token 管理' : 'Token 用量'}</button></nav><div class="sidebar-foot"><strong>${esc(state.user.name)}</strong><p>${admin ? '管理员' : '员工'} · ${esc(state.user.username)}</p><button class="small quiet" data-action="password">修改密码</button><button class="small quiet" data-action="logout">退出登录</button></div></aside><main class="workspace"><header class="topline"><div><div class="eyebrow">DAOCUT WORKSPACE</div><h1>${title}</h1><p>${state.tab === 'users' ? '管理同事的访问权限，让每个账号都有明确归属' : state.tab === 'usage' ? '查看用量与当前额度，按北京时间自动换日、换月' : '集中记录问题、诊断资料与处理进度'}</p></div><div class="toolbar"><button data-action="refresh">刷新</button>${state.tab === 'users' ? '<button class="primary" data-action="create">新增员工</button>' : state.tab === 'feedback' ? '<button class="primary" data-action="feedback">提交反馈</button>' : ''}<button class="quiet" data-action="logout">退出</button></div></header>${admin && state.tab !== 'usage' ? `<section class="stats"><div class="stat"><span>员工账号</span><strong>${state.users.filter((user) => user.role !== 'admin').length}</strong></div><div class="stat"><span>已启用账号</span><strong>${state.users.filter((user) => user.enabled).length}</strong></div><div class="stat"><span>待处理反馈</span><strong>${pending}</strong></div></section>` : ''}${state.tab === 'users' ? usersView() : state.tab === 'usage' ? usageView(admin) : feedbackView(admin)}</main></div>`);
}
function usersView() {
  return `<section class="panel"><div class="panel-header"><div><h2>账号列表</h2><p>停用或重置密码后，原有登录会话立即失效</p></div><span class="badge">${state.users.length} 个账号</span></div><div class="table-wrap"><table><thead><tr><th>姓名 / 账号</th><th>身份</th><th>状态</th><th></th></tr></thead><tbody>${state.users.map((user) => `<tr><td>${esc(user.name)}<small>${esc(user.username)}</small></td><td>${user.role === 'admin' ? '管理员' : '员工'}</td><td><span class="badge ${user.enabled ? 'blue' : 'disabled'}">${user.enabled ? '已启用' : '已停用'}</span></td><td><div class="row-actions"><button class="small" data-action="quota" data-id="${esc(user.id)}">Token 额度</button><button class="small" data-action="reset" data-id="${esc(user.id)}">重置密码</button>${user.id !== state.user.id ? `<button class="small ${user.enabled ? 'danger' : ''}" data-action="status" data-id="${esc(user.id)}">${user.enabled ? '停用' : '启用'}</button>` : '<span class="badge">当前账号</span>'}</div></td></tr>`).join('')}</tbody></table></div><div class="note">员工自行配置 AI 服务 API Key。公司服务管理账号、反馈、Token 用量与额度和应用更新。</div></section>`;
}
function feedbackView(admin) {
  const list = state.feedback.filter((item) => state.filter === 'all' || item.status === state.filter);
  return `<section class="panel"><div class="panel-header"><div><h2>${admin ? '全部反馈' : '反馈记录'}</h2><p>显示最近 500 条记录</p></div><select id="feedback-filter" aria-label="筛选处理状态"><option value="all">全部状态</option>${Object.entries(statusLabels).map(([key, value]) => `<option value="${key}" ${state.filter === key ? 'selected' : ''}>${value}</option>`).join('')}</select></div>${list.length ? list.map((item) => `<article class="feedback-item"><div class="feedback-title"><h3>${esc(item.title)}</h3><span class="badge ${['new', 'in_progress'].includes(item.status) ? 'blue' : ''}">${statusLabels[item.status]}</span></div><div class="meta">${categoryLabels[item.category]} · ${esc(item.userName)} · ${esc(new Date(item.createdAt).toLocaleString('zh-CN'))}${item.appVersion ? ` · v${esc(item.appVersion)}` : ''}${item.platform ? ` · ${esc(item.platform)}` : ''}</div><p class="feedback-body">${esc(item.description)}</p>${item.adminNote ? `<div class="feedback-note">处理说明<br>${esc(item.adminNote)}</div>` : ''}<div class="feedback-actions">${item.hasDiagnostics || item.attachments?.length ? `<button class="small" data-action="feedback-detail" data-id="${esc(item.id)}">查看${item.hasDiagnostics ? '诊断' : ''}${item.hasDiagnostics && item.attachments?.length ? '与' : ''}${item.attachments?.length ? `截图（${item.attachments.length}）` : ''}</button>` : ''}${admin ? `<button class="small" data-action="triage" data-id="${esc(item.id)}">更新进度</button>` : ''}</div></article>`).join('') : '<div class="empty">这里还没有反馈记录</div>'}</section>`;
}
const number = (value) => Number(value || 0).toLocaleString('zh-CN');
const syncTime = (value) => value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '尚未同步';
function usageTable(title, rows, label) {
  return `<section class="panel usage-section"><div class="panel-header"><h2>${title}</h2></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>${label}</th><th>Token 合计</th><th>未缓存输入</th><th>输出</th><th>缓存读取 / 写入</th><th>请求 / 不完整</th></tr></thead><tbody>${rows.map((item) => `<tr><td>${esc(item.name || item.model || item.date)}${item.username ? `<small>${esc(item.username)} · ${esc(syncTime(item.lastSyncedAt))}</small>` : ''}</td><td>${number(item.total)}</td><td>${number(item.input)}</td><td>${number(item.output)}<small>含推理 ${number(item.reasoning)}</small></td><td>${number(item.cacheRead)} / ${number(item.cacheWrite)}</td><td>${number(item.requests)} / ${number(item.incompleteRequests)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty">这个范围暂无用量记录</div>'}</section>`;
}
function quotaAmount(value) { return value === null ? '不限' : number(value); }
function quotaBalance(period) {
  return `<strong class="quota-remaining ${period.remaining === 0 ? 'exhausted' : ''}">${quotaAmount(period.remaining)}</strong><span class="quota-caption">${period.remaining === null ? '不设上限' : '剩余 Token'}</span><small>额度 ${quotaAmount(period.limit)} · 已用 ${number(period.used)}</small><small>预占 ${number(period.reserved)}</small>`;
}
function quotaView(admin) {
  const intro = '<p>当前额度不受下方日期、员工或模型筛选影响。每日 00:00、每月 1 日 00:00 按北京时间进入新周期。</p>';
  const help = '<div class="note">预占包含进行中或等待用量回执的请求，收到回执后按实际用量结算。缓存输入计入额度，推理 Token 已包含在输出中，不重复计算。<br>额度只对支持额度管理的新版 Daocut 内的新 AI 请求生效；旧版 Daocut 和其他软件不受此额度限制。手动编辑、导出照常使用，API Key 仍由员工自行配置。</div>';
  if (state.quotaLoading) return `<section class="panel usage-section quota-panel"><div class="panel-header"><div><h2>当前 Token 额度</h2>${intro}</div></div><div class="empty" role="status">正在加载额度…</div></section>`;
  if (state.quotaError) return `<section class="panel usage-section quota-panel"><div class="panel-header"><h2>当前 Token 额度</h2></div><div class="quota-error" role="alert">${esc(state.quotaError)}<p>请点击页面右上方“刷新”重试，当前无法确认剩余额度。</p></div></section>`;
  if (!state.quotas.length) return '';
  const [first] = state.quotas;
  const head = `<div class="panel-header"><div><h2>当前 Token 额度</h2>${intro}</div><span class="badge">北京时间</span></div>`;
  if (admin) return `<section class="panel usage-section quota-panel">${head}<div class="table-wrap"><table class="quota-table"><thead><tr><th>员工 / 账号</th><th>今日 · ${esc(first.daily.period)}</th><th>本月 · ${esc(first.monthly.period)}</th><th></th></tr></thead><tbody>${state.quotas.map((quota) => `<tr><td>${esc(quota.name)}<small>${esc(quota.username)}${quota.enabled ? '' : ' · 已停用'}</small></td><td>${quotaBalance(quota.daily)}</td><td>${quotaBalance(quota.monthly)}</td><td><button class="small" data-action="quota" data-id="${esc(quota.userId)}">设置额度</button></td></tr>`).join('')}</tbody></table></div>${help}</section>`;
  return `<section class="panel usage-section quota-panel">${head}<div class="quota-grid">${[['今日', first.daily], ['本月', first.monthly]].map(([label, period]) => `<div class="quota-card"><h3>${label}<span>${esc(period.period)}</span></h3>${quotaBalance(period)}</div>`).join('')}</div>${help}</section>`;
}
function showQuotaModal(user, quota) {
  const field = (key, label, period) => `<div class="field"><label for="quota-${key}">${label} Token 额度</label><input id="quota-${key}" name="${key}Limit" type="number" min="0" max="9007199254740991" step="1" inputmode="numeric" value="${period.limit === null ? '' : esc(period.limit)}" placeholder="不限"><small>当前已用 ${number(period.used)} · 预占 ${number(period.reserved)} · 剩余 ${quotaAmount(period.remaining)}</small></div>`;
  modal(`设置 ${user.name} 的 Token 额度`, '按北京时间自动换日、换月。日额度和月额度同时生效，任一额度不足时暂停新的 AI 请求。', `${field('daily', '每日', quota.daily)}${field('monthly', '每月', quota.monthly)}<div class="quota-hint">留空表示不限；填 0 表示暂停新 AI 请求。已开始的请求会完成结算，不会中断手动编辑或导出。<br>降低额度不会清除已有用量或预占。</div>`, 'quota', user.id);
}
function quotaLimit(value) {
  if (!String(value ?? '').trim()) return null;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error('额度请填写 0 或更大的整数，或留空表示不限');
  return result;
}
function usageView(admin) {
  const filter = state.usageFilters; const data = state.usage; const quota = quotaView(admin);
  const filters = `<section class="panel usage-section"><form class="usage-filters" data-form="usage"><div><label for="usage-from">开始日期</label><input id="usage-from" name="from" type="date" required value="${esc(filter.from)}"></div><div><label for="usage-to">结束日期</label><input id="usage-to" name="to" type="date" required value="${esc(filter.to)}"></div>${admin ? `<div><label for="usage-user">员工</label><select id="usage-user" name="userId"><option value="">全部员工</option>${state.users.map((user) => `<option value="${esc(user.id)}" ${filter.userId === user.id ? 'selected' : ''}>${esc(user.name)} · ${esc(user.username)}</option>`).join('')}</select></div>` : ''}<div><label for="usage-model">模型</label><select id="usage-model" name="model"><option value="">全部模型</option>${[...new Set([...(data?.availableModels || []), ...(filter.model ? [filter.model] : [])])].map((model) => `<option value="${esc(model)}" ${filter.model === model ? 'selected' : ''}>${esc(model)}</option>`).join('')}</select></div><button type="submit" class="primary" ${state.usageLoading ? 'disabled' : ''}>查询</button><div class="form-error" role="alert">${esc(state.usageError)}</div></form></section>`;
  if (state.usageLoading) return `${quota}${filters}<section class="panel"><div class="empty" role="status">正在加载用量…</div></section>`;
  if (state.usageError) return quota + filters;
  if (!data) return `${quota}${filters}<section class="panel"><div class="empty">选择日期查看用量</div></section>`;
  const total = data.totals;
  return `${quota}${filters}<section class="stats"><div class="stat"><span>累计 Token${total.incompleteRequests ? '（部分统计）' : ''}</span><strong>${number(total.total)}</strong></div><div class="stat"><span>模型请求</span><strong>${number(total.requests)}</strong></div><div class="stat"><span>用量不完整的请求</span><strong>${number(total.incompleteRequests)}</strong></div></section>${total.costs ? `<div class="usage-cost">已知费用 ${Object.entries(total.costs).map(([currency, amount]) => `${esc(currency)} ${Number(amount).toLocaleString('zh-CN', { maximumFractionDigits: 6 })}`).join(' · ')}</div>` : ''}<p class="usage-note">仅统计启用后在 Daocut 中产生并同步的用量。缺少接口用量回执时标记为不完整。最近同步：${esc(syncTime(data.lastSyncedAt))}</p>${usageTable(admin ? '按员工' : '我的用量', data.employees, '员工 / 最近同步')}${usageTable('按模型', data.models, '模型')}${usageTable('按日期', data.daily, '日期（北京时间）')}`;
}
let usageRequest = 0;
function clearUsage() {
  usageRequest++; state.usage = null; state.usageError = ''; state.usageLoading = false; state.quotas = []; state.quotaError = ''; state.quotaLoading = false;
  state.usageFilters.userId = ''; state.usageFilters.model = '';
}
async function loadUsage() {
  const request = ++usageRequest; const user = state.user;
  state.usageLoading = true; state.usageError = ''; state.quotaLoading = true; state.quotaError = ''; render();
  const [usage, quota] = await Promise.allSettled([
    api(`/usage?${new URLSearchParams(state.usageFilters)}`),
    api(user.role === 'admin' ? '/quotas' : '/quota'),
  ]);
  if (request !== usageRequest || state.user !== user) return;
  if (usage.status === 'fulfilled') state.usage = usage.value;
  else state.usageError = usage.reason.message;
  if (quota.status === 'fulfilled') state.quotas = user.role === 'admin' ? quota.value.quotas : [quota.value.quota];
  else { state.quotas = []; state.quotaError = quota.reason.message; }
  state.usageLoading = false; state.quotaLoading = false;
  if (state.tab === 'usage' && !document.querySelector('.modal-layer')) render();
}
async function showFeedbackDetail(id) {
  const user = state.user;
  const { feedback: item } = await api(`/feedback/${encodeURIComponent(id)}`);
  if (!user || state.user !== user) return;
  document.querySelector('.modal-layer')?.remove();
  const layer = document.createElement('div'); layer.className = 'modal-layer';
  const diagnostic = item.diagnostics;
  layer.innerHTML = `<section class="modal diagnostic-modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><h2 id="dialog-title">${esc(item.title)}</h2><p>员工主动附加的诊断资料</p>${diagnostic ? `<h3>基础诊断</h3><pre class="diagnostic-text">${esc(diagnostic.report)}</pre>${diagnostic.details ? `<details><summary>失败回合的详细记录</summary><pre class="diagnostic-text">${esc(diagnostic.details)}</pre></details>` : ''}` : ''}${item.attachments?.length ? `<h3>截图</h3><div class="feedback-images">${item.attachments.map((image) => `<a href="/api/company/feedback/${encodeURIComponent(item.id)}/attachments/${encodeURIComponent(image.id)}" target="_blank" rel="noopener"><img loading="lazy" src="/api/company/feedback/${encodeURIComponent(item.id)}/attachments/${encodeURIComponent(image.id)}" alt="${esc(image.name)}"><span>${esc(image.name)}</span></a>`).join('')}</div>` : ''}<footer><button data-action="close-modal">关闭</button></footer></section>`;
  app.append(layer); layer.querySelector('button')?.focus();
}
async function refresh() {
  state.feedback = (await api('/feedback')).feedback;
  if (state.user.role === 'admin') state.users = (await api('/users')).users;
  else if (state.tab === 'users') state.tab = 'feedback';
  if (state.tab === 'usage') return loadUsage();
  render();
}
function modal(title, description, fields, form, id = '') {
  document.querySelector('.modal-layer')?.remove();
  const layer = document.createElement('div'); layer.className = 'modal-layer';
  layer.innerHTML = `<section class="modal" role="dialog" aria-modal="true" aria-labelledby="dialog-title"><h2 id="dialog-title">${esc(title)}</h2><p>${esc(description)}</p><form data-form="${form}" data-id="${esc(id)}">${fields}<div class="form-error" role="alert"></div><footer><button type="button" data-action="close-modal">取消</button><button type="submit" class="primary">确认</button></footer></form></section>`;
  app.append(layer); layer.querySelector('input,textarea,select')?.focus();
}
async function closeModal() {
  const layer = document.querySelector('.modal-layer'); if (!layer) return;
  await layer.animate([{ opacity: 1 }, { opacity: 0 }], { duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 1 : 150 }).finished;
  layer.remove();
}
const passwordField = '<div class="field"><label for="new-password">新密码</label><input id="new-password" name="password" type="password" required minlength="10" maxlength="128" autocomplete="new-password"><small>至少 10 个字符；通过公司已有的安全方式告知本人</small></div>';
app.addEventListener('click', async (event) => {
  const button = event.target.closest('button'); if (!button) return;
  if (button.dataset.tab) { state.tab = button.dataset.tab; if (state.tab === 'usage') await loadUsage(); else render(); return; }
  const action = button.dataset.action; const user = state.users.find((item) => item.id === button.dataset.id);
  try {
    if (action === 'logout') { await api('/logout', { method: 'POST', body: {} }); clearUsage(); state.user = null; state.users = []; state.feedback = []; render(); }
    if (action === 'refresh') { button.disabled = true; await refresh(); }
    if (action === 'close-modal') await closeModal();
    if (action === 'feedback-detail') { button.disabled = true; await showFeedbackDetail(button.dataset.id); button.disabled = false; }
    if (action === 'create') modal('新增员工账号', '账号供同事登录 Daocut 使用', '<div class="field"><label for="employee-name">姓名</label><input id="employee-name" name="name" required maxlength="80"></div><div class="field"><label for="employee-username">账号</label><input id="employee-username" name="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9][A-Za-z0-9._-]*" autocomplete="off"><small>3–32 位英文字母、数字、点、下划线或短横线</small></div>' + passwordField, 'create');
    if (action === 'quota' && state.user.role === 'admin') {
      const sessionUser = state.user; button.disabled = true;
      const { quotas } = await api('/quotas');
      if (state.user !== sessionUser || !button.isConnected) return;
      const quota = quotas.find((item) => item.userId === button.dataset.id);
      if (!quota) throw new Error('没有找到此账号的额度，请刷新后重试');
      state.quotas = quotas; button.disabled = false; showQuotaModal({ id: quota.userId, name: quota.name }, quota);
    }
    if (action === 'reset' && user) modal(`重置 ${user.name} 的密码`, '此账号所有设备上的旧登录会话都会失效', passwordField, 'reset', user.id);
    if (action === 'status' && user) modal(`${user.enabled ? '停用' : '启用'} ${user.name}`, user.enabled ? '账号停用后将无法登录，已有登录会话立即失效。需要时可以重新启用。' : '启用后员工可使用现有密码重新登录。', '', 'status', user.id);
    if (action === 'password') modal('修改我的密码', '其他设备上的登录会话将失效', '<div class="field"><label for="current-password">原密码</label><input id="current-password" name="currentPassword" type="password" required maxlength="128" autocomplete="current-password"></div>' + passwordField, 'password');
    if (action === 'feedback') modal('提交反馈', '请描述操作步骤与实际现象。请勿填写 API Key、密码或粘贴完整工作素材。', `<div class="field"><label for="category">类型</label><select id="category" name="category">${Object.entries(categoryLabels).map(([key, value]) => `<option value="${key}">${value}</option>`).join('')}</select></div><div class="field"><label for="title">标题</label><input id="title" name="title" required maxlength="120"></div><div class="field"><label for="description">详细说明</label><textarea id="description" name="description" required maxlength="8000" rows="5"></textarea></div>`, 'feedback');
    if (action === 'triage') {
      const item = state.feedback.find((entry) => entry.id === button.dataset.id); if (!item) return;
      modal('更新反馈进度', item.title, `<div class="field"><label for="status">处理状态</label><select id="status" name="status">${Object.entries(statusLabels).map(([key, value]) => `<option value="${key}" ${key === item.status ? 'selected' : ''}>${value}</option>`).join('')}</select></div><div class="field"><label for="adminNote">处理说明（反馈人可见）</label><textarea id="adminNote" name="adminNote" maxlength="4000" rows="4">${esc(item.adminNote)}</textarea></div>`, 'triage', item.id);
    }
  } catch (error) { toast(error.message); button.disabled = false; }
});
app.addEventListener('change', (event) => { if (event.target.id === 'feedback-filter') { state.filter = event.target.value; render(); } });
app.addEventListener('submit', async (event) => {
  const form = event.target; if (!(form instanceof HTMLFormElement)) return; event.preventDefault();
  const type = form.dataset.form; const body = Object.fromEntries(new FormData(form)); const submit = form.querySelector('button[type="submit"]'); const errorBox = form.querySelector('.form-error');
  submit.disabled = true; errorBox.textContent = '';
  try {
    if (type === 'usage') { state.usageFilters = { ...state.usageFilters, ...body }; await loadUsage(); return; }
    if (type === 'setup') { await api('/setup', { method: 'POST', body }); state.setup = false; render(); toast('管理员已创建，请登录'); return; }
    if (type === 'login') { state.user = (await api('/login', { method: 'POST', body })).user; clearUsage(); state.tab = state.user.role === 'admin' ? 'users' : 'feedback'; await refresh(); return; }
    if (type === 'create') await api('/users', { method: 'POST', body });
    if (type === 'reset') await api(`/users/${form.dataset.id}/password`, { method: 'POST', body });
    if (type === 'status') { const user = state.users.find((item) => item.id === form.dataset.id); await api(`/users/${user.id}/status`, { method: 'POST', body: { enabled: !user.enabled } }); }
    if (type === 'password') await api('/password', { method: 'POST', body: { currentPassword: body.currentPassword, newPassword: body.password } });
    if (type === 'feedback') await api('/feedback', { method: 'POST', body: { ...body, platform: '管理台浏览器' } });
    if (type === 'triage') await api(`/feedback/${form.dataset.id}`, { method: 'PATCH', body });
    if (type === 'quota') {
      const sessionUser = state.user;
      await api(`/users/${encodeURIComponent(form.dataset.id)}/quota`, { method: 'PUT', body: { dailyLimit: quotaLimit(body.dailyLimit), monthlyLimit: quotaLimit(body.monthlyLimit) } });
      if (state.user !== sessionUser || !form.isConnected) return;
    }
    await closeModal(); toast('已保存'); await refresh();
  } catch (error) { errorBox.textContent = error.message; } finally { submit.disabled = false; }
});
addEventListener('keydown', (event) => { if (event.key === 'Escape') closeModal(); const dialog = document.querySelector('.modal'); if (event.key !== 'Tab' || !dialog) return; const controls = [...dialog.querySelectorAll('button,input,select,textarea,a[href],summary')].filter((element) => !element.disabled); if (event.shiftKey && document.activeElement === controls[0]) { controls.at(-1).focus(); event.preventDefault(); } else if (!event.shiftKey && document.activeElement === controls.at(-1)) { controls[0].focus(); event.preventDefault(); } });
try {
  const health = await api('/health'); state.setup = health.setupRequired;
  if (!state.setup) { try { state.user = (await api('/session')).user; } catch {} }
  if (state.user) await refresh(); else render();
} catch (error) { swap(`<main class="auth-layout"><section class="auth-card">${brand}<h1>暂时无法连接</h1><p>${esc(error.message)}</p><button data-action="reload">重新加载</button></section></main>`); app.addEventListener('click', (event) => { if (event.target.closest('[data-action="reload"]')) location.reload(); }); }

