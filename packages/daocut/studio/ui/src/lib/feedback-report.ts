/** Bound the exact diagnostic text previewed and sent; complete diagnostics remain available as a local export. */
export function feedbackReport(report: string, problems: Array<{ t: string; area: string; what: string; agent?: string; step?: string }>): string {
  const recent = problems.slice(0, 20);
  const text = `${report}\n\nRecent problems (up to 20)\n${recent.length ? recent.map((p) => `${p.t} · ${[p.agent ?? p.area, p.step].filter(Boolean).join(' / ')}\n${p.what}`).join('\n\n') : 'None'}${problems.length > recent.length ? '\n\nOnly the 20 most recent problems are attached; export local diagnostics for the complete list.' : ''}`;
  const bytes = new TextEncoder().encode(text);
  const max = 64 * 1024;
  if (bytes.byteLength <= max) return text;
  const marker = '\n\n[已截短 / Truncated at 64 KiB. 完整内容请导出本地诊断 / Export local diagnostics for the complete report.]';
  const room = max - new TextEncoder().encode(marker).byteLength;
  // Drop an incomplete final UTF-8 sequence instead of producing a replacement character.
  let end = room;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end)) + marker;
}
