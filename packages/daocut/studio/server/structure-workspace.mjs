import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureStructureDraft, listStructureDrafts, structureDraftContext } from './structure-drafts.mjs';
import { writeAtomic } from './atomic.mjs';
import { openProject } from './projects.mjs';
import { HttpError, json, readJson } from './http.mjs';

export function createStructureWorkspace({ plans, batches, register = openProject }) {
  const assertOwner = async project => { if (await structureDraftContext(project.path)) throw new HttpError(409, '请从原工程打开公共方案'); };
  const draftsOf = async project => Promise.all((await listStructureDrafts(project.path)).map(async draft => ({ ...draft, projectId: (await readFile(join(draft.root, '.film/id'), 'utf8')).trim() })));
  async function read(project) {
    await assertOwner(project);
    const drafts = (await draftsOf(project)).map(({ meta, projectId }) => ({ projectId, planId: meta.planId, planVersion: meta.planVersion, scope: meta.scope, durationMs: meta.durationMs }));
    let selected = null;
    try { selected = JSON.parse(await readFile(join(project.path, '.film/structure-workspace.json'), 'utf8')).activeProjectId; }
    catch (error) { if (error.code !== 'ENOENT') throw new HttpError(409, '草稿选择记录无法读取，文件已保留'); }
    return { ownerId: project.id, activeProjectId: drafts.some(draft => draft.projectId === selected) ? selected : project.id, drafts };
  }
  async function select(project, projectId) {
    const current = await read(project);
    if (projectId && projectId !== project.id) {
      const draft = (await draftsOf(project)).find(draft => draft.projectId === projectId);
      if (!draft) throw new HttpError(404, '找不到此工程的个人草稿');
      projectId = (await register(draft.root)).id;
    }
    const activeProjectId = projectId || project.id;
    await writeAtomic(join(project.path, '.film/structure-workspace.json'), JSON.stringify({ version: 1, activeProjectId }));
    return { ...(await read(project)), activeProjectId };
  }
  async function edit(project, request) {
    await assertOwner(project);
    const state = await plans.status(project.path, request);
    const plan = state.status === 'complete' && state.taskKey === request.taskKey && state.context?.visibility === 'shared' && state.plans?.find(plan => plan.id === request.planId);
    if (!plan) throw new HttpError(409, '找不到此讲解段已保存的公共方案，请重新读取方案列表');
    const draft = await ensureStructureDraft(project.path, { parentProjectId: project.id, plan });
    return { project: await register(draft.root), meta: draft.meta };
  }
  async function route(req, res, project, rest, authorize = async () => {}) {
    if (!rest.startsWith('structure-')) return false;
    const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    let body;
    if (batches && rest.startsWith('structure-exports')) {
      await assertOwner(project);
      const parts = rest.split('/');
      if (parts.length === 1 && req.method === 'GET') body = await batches.list(project);
      else if (parts.length === 1 && req.method === 'POST') body = await batches.create(project, await readJson(req));
      else if (parts.length === 3 && parts[2] === 'retry' && req.method === 'POST') body = await batches.retry(project, parts[1]);
      else if (parts.length === 3 && parts[2] === 'cancel' && req.method === 'POST') body = await batches.cancel(project, parts[1]);
      else if (parts.length === 3 && parts[2] === 'reveal' && req.method === 'POST') body = await batches.reveal(project, parts[1]);
      else return false;
    }
    else if (req.method === 'GET' && rest === 'structure-workspace') body = await read(project);
    else if (req.method === 'POST' && rest === 'structure-workspace/select') body = await select(project, (await readJson(req)).projectId);
    else if (req.method === 'POST' && rest === 'structure-drafts') body = await edit(project, await readJson(req));
    else if (req.method === 'GET' && rest === 'structure-plans') { await assertOwner(project); body = await plans.status(project.path, query); }
    else if (req.method === 'POST' && rest === 'structure-plans/generate') { await assertOwner(project); await authorize(); body = await plans.generate(project.path, await readJson(req)); }
    else if (req.method === 'POST' && rest === 'structure-plans/publish') { await assertOwner(project); await authorize(); body = await plans.publish(project.path, await readJson(req)); }
    else return false;
    json(res, 200, body); return true;
  }
  return { read, select, edit, route };
}
