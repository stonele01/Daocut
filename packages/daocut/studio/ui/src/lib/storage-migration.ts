/** Copy old preference keys once, keeping both the old data and any newer choice. */
const MARKER = 'daocut.migration.storage.v1';
export function migrateBrandStorage(storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem'>): void {
  if (storage.getItem(MARKER) === '1') return;
  const oldKeys = Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => Boolean(key && /^openfilm[.:-]/.test(key)));
  for (const oldKey of oldKeys) {
    const newKey = oldKey.replace(/^openfilm/, 'daocut');
    if (storage.getItem(newKey) !== null) continue;
    const value = storage.getItem(oldKey);
    if (value !== null) storage.setItem(newKey, value);
  }
  storage.setItem(MARKER, '1');
}
if (typeof window !== 'undefined') {
  try { migrateBrandStorage(window.localStorage); } catch { /* private browsing */ }
  try { migrateBrandStorage(window.sessionStorage); } catch { /* private browsing */ }
}
