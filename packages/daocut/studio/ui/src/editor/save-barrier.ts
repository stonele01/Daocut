/** Wait for all film writes, including ones queued while waiting, before export reads the project. */
export async function waitForFilmSave(queue: () => Promise<unknown>, takeFailure: () => string | null, broken: () => boolean): Promise<void> {
  for (;;) {
    const pending = queue();
    await pending;
    if (queue() === pending) break;
  }
  const failure = takeFailure();
  if (failure) throw new Error(`成片保存失败，无法导出：${failure}`);
  if (broken()) throw new Error('成片文件无法读取，请先修复后导出');
}
