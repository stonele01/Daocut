/** Only completed rounds can expose saved plans while a later v4 batch is unfinished. */
export function isSavedStructurePlanUsable(state, planId) {
  if (!state?.plans?.some(plan => plan.id === planId)) return false;
  if (state.status === 'complete') return true;
  return ['ai-structure-plans-v4', 'ai-structure-plans-v5', 'ai-structure-plans-v6'].includes(state.version)
    && ['running', 'busy', 'failed', 'publish-pending'].includes(state.status)
    && Array.isArray(state.usablePlanIds) && state.usablePlanIds.includes(planId);
}
