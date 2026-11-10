/** A narrow account bridge for trusted Studio frames, never exposing the bearer token. */
import { readFileSync, statSync } from 'node:fs';

export function registerCompanyIpc(ipcMain, { trusted, client, pickProfile, openExternal }) {
  const handle = (channel, fn) => ipcMain.handle('desktop:company:' + channel, (event, input) => {
    if (!trusted(event)) throw new Error('not the window\'s page');
    return fn(input);
  });
  handle('state', () => client.state());
  handle('refresh', () => client.refresh());
  handle('login', (input) => client.login({ username: input?.username, password: input?.password }));
  handle('logout', () => client.logout());
  handle('import-profile', async () => {
    const file = await pickProfile();
    if (!file) return client.state();
    if (statSync(file).size > 128 * 1024) throw new Error('公司连接文件过大。');
    let profile;
    try { profile = JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error('公司连接文件不是有效的 JSON 文件。'); }
    return client.configure(profile);
  });
  handle('feedback-submit', (input) => client.submitFeedback({ category: input?.category, title: input?.title, description: input?.description,
    ...(input?.identity != null ? { identity: { serverUrl: input.identity.serverUrl, userId: input.identity.userId } } : {}),
    ...(input?.diagnostics != null ? { diagnostics: input.diagnostics } : {}),
    ...(input?.attachments != null ? { attachments: input.attachments } : {}),
  }));
  handle('feedback', () => client.feedback());
  handle('feedback-details', (input) => client.feedbackDetails(input?.id));
  handle('admin', async () => { await openExternal(await client.adminUrl()); });
}


/** Saving a model probes its vision API, so it is new AI work; deleting a model remains local. */
export async function saveModelWithCompanySession(config, { authorizeTask, saveModel }) {
  try { await authorizeTask(); }
  catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '请先登录公司账号。', code: 'company-auth-required' };
  }
  return saveModel(config);
}
