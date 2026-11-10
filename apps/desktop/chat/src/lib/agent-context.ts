/** Independent SDK content estimates; these need not add up to the agent's reported total. */
export interface AgentContextBreakdown {
  source: 'local-estimate';
  system: number;
  tools: number;
  messages: number;
}

/** A session snapshot, never the sum of billed requests. Unknown is distinct from zero. */
export interface AgentContext { used: number; size: number; breakdown?: AgentContextBreakdown }

function readBreakdown(value: unknown): AgentContextBreakdown | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { source, system, tools, messages } = value as Record<string, unknown>;
  const tokens = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  return source === 'local-estimate' && tokens(system) && tokens(tools) && tokens(messages)
    ? { source, system, tools, messages } : undefined;
}

/** Undefined means unrelated; null explicitly clears a stale snapshot. */
export function readAgentContext(update: Record<string, unknown>): AgentContext | null | undefined {
  if (update.sessionUpdate === 'session_info_update') {
    const meta = update._meta as Record<string, unknown> | null | undefined;
    return meta?.['daocut/contextUsage'] === null ? null : undefined;
  }
  if (update.sessionUpdate !== 'usage_update') return undefined;
  const { used, size } = update;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0
    || typeof size !== 'number' || !Number.isFinite(size) || size <= 0) return null;
  const meta = update._meta as Record<string, unknown> | null | undefined;
  const breakdown = readBreakdown(meta?.['daocut/contextBreakdown']);
  // Every update is a complete snapshot; an external agent or missing details cannot inherit stale categories.
  return { used, size, ...(breakdown ? { breakdown } : {}) };
}

/** A new menu choice is not yet the model running in an existing ACP session. */
export function contextForModel(context: AgentContext | null, actual: unknown, selected: unknown): AgentContext | null {
  return selected !== undefined && actual !== selected ? null : context;
}

export function contextPercent(context: AgentContext | null): number | null {
  return context ? Math.round(context.used / context.size * 100) : null;
}
