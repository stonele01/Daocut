import { HttpError } from './http.mjs';

/** Only file moves need exclusive access; other writes retain their own existing queues. */
export function createProjectMoveGate() {
  const projects = new Map();
  return {
    enter(root, mode) {
      const current = projects.get(root) ?? { moving: false, writes: 0 };
      if (current.moving || (mode === 'move' && current.writes)) throw new HttpError(409, '工程正在保存或移动素材，请完成后重试；本次未修改关联', { code: 'source-move-busy' });
      if (mode === 'read') return () => {};
      if (mode === 'move') current.moving = true;
      else current.writes++;
      projects.set(root, current);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (mode === 'move') current.moving = false;
        else current.writes--;
        if (!current.moving && !current.writes) projects.delete(root);
      };
    },
  };
}
