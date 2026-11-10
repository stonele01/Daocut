import { realpath } from 'node:fs/promises';
import { createOneShotSample } from './one-shot-sample.mjs';
import { startStudio } from './server.mjs';

// Trusted caller must first close other Studio writers and obtain separate user authorization.
// This function does not shut down or discover other processes.
export async function runOneShotSample({ enabled, projectId, ...options } = {}) {
  if (enabled !== true) return null;
  if (typeof projectId !== 'string' || !projectId) throw new Error('缺少项目身份');
  const sample = createOneShotSample({ ...options, enabled: true });
  const studio = await startStudio({ port: 0, openBrowser: () => {}, liveAnalysis: { modelClient: sample.modelClient, modelIdentity: options.modelIdentity, readTranscript: options.readTranscript, probeSource: options.probeSource } });
  try {
    const api = async (path, method = 'GET', body) => {
      const response = await fetch(`${studio.origin}${path}`, { method, headers: { 'x-studio-key': studio.key, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (!response.ok) throw new Error('本地分析请求失败');
      return response.json();
    };
    const projects = (await api('/api/projects')).projects;
    const project = projects.find(p => p.id === projectId);
    if (!project || await realpath(project.path) !== await realpath(options.root)) throw new Error('项目身份不匹配');
    await sample.prepareScope();
    const path = `/api/projects/${encodeURIComponent(projectId)}/live-analysis`;
    let state = await api(`${path}/analyze`, 'POST', { sourceId: options.sourceId, intervalId: options.intervalId, confirmed: true });
    while (state.analysis.status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 100));
      state = await api(`${path}?sourceId=${encodeURIComponent(options.sourceId)}`);
    }
    if (state.analysis.status !== 'complete') throw new Error('文字分析未完成');
    return state;
  } finally { await studio.close(); }
}
