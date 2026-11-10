// @ts-check
/** New configuration names win; old names remain read-only aliases for existing installations. */
export function brandEnv(/** @type {string} */ name, /** @type {Record<string, string | undefined>} */ env = process.env) {
  const legacy = name === 'STUDIO_HOME' ? 'HOME' : name;
  return env['DAOCUT_' + name] ?? env['OPENFILM_' + legacy];
}
/** Preserve values and credentials while adding the current names for an inherited environment. */
export function brandEnvironment(/** @type {Record<string, string | undefined>} */ env) {
  const next = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('OPENFILM_')) continue;
    const suffix = key.slice(9);
    next['DAOCUT_' + (suffix === 'HOME' ? 'STUDIO_HOME' : suffix)] ??= value;
  }
  return next;
}
