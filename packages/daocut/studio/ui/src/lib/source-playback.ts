/** Source-preview diagnostics stay in the component; never include its authenticated media URL. */
export interface SourcePlaybackDiagnostic {
  event: string;
  atMs: number;
  errorName?: string;
  message?: string;
  mediaError?: string;
  readyState: number;
  networkState: number;
  currentTime: number;
  buffered: [number, number][];
}

const mediaErrors = ['', 'MEDIA_ERR_ABORTED', 'MEDIA_ERR_NETWORK', 'MEDIA_ERR_DECODE', 'MEDIA_ERR_SRC_NOT_SUPPORTED'];
const seconds = (value: number) => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;

export function playbackDiagnostic(media: HTMLMediaElement, event: string, error?: unknown): SourcePlaybackDiagnostic {
  const detail = error instanceof Error || error instanceof DOMException ? error : null;
  const clean = (message: string) => message
    .replace(/(?:https?|file|blob):[^\s"'<>]+/gi, '[地址已隐藏]')
    .replace(/(?:[a-z]:[\\/]|\\\\)[^\r\n"'<>]*/gi, '[路径已隐藏]')
    .replace(/\b(?:key|token|authorization|password)\s*[:=]\s*[^\s,;]+/gi, '[凭据已隐藏]')
    .slice(0, 400);
  const buffered: [number, number][] = [];
  for (let index = 0; index < Math.min(media.buffered.length, 8); index++) {
    try { buffered.push([seconds(media.buffered.start(index)), seconds(media.buffered.end(index))]); } catch { break; }
  }
  return {
    event, atMs: Math.round(performance.now()), readyState: media.readyState, networkState: media.networkState,
    currentTime: seconds(media.currentTime), buffered,
    ...(detail ? { errorName: detail.name, message: clean(detail.message) } : {}),
    ...(media.error ? { mediaError: mediaErrors[media.error.code] || `MEDIA_ERROR_${media.error.code}`, message: clean(media.error.message) } : {}),
  };
}

export function playbackFailureText(diagnostic: SourcePlaybackDiagnostic) {
  if (diagnostic.mediaError === 'MEDIA_ERR_NETWORK') return '视频读取失败，请检查素材连接后重新打开。';
  if (diagnostic.mediaError === 'MEDIA_ERR_DECODE') return '视频解码失败，请查看播放诊断。';
  if (diagnostic.mediaError === 'MEDIA_ERR_SRC_NOT_SUPPORTED' || diagnostic.errorName === 'NotSupportedError') return '视频无法读取或格式不受支持，请查看播放诊断。';
  if (diagnostic.errorName === 'NotAllowedError') return '播放需要手动确认，请点击播放按钮。';
  if (diagnostic.mediaError === 'MEDIA_ERR_ABORTED' || diagnostic.errorName === 'AbortError') return '播放被中断，请点击播放按钮重试。';
  return '播放未能启动，请查看播放诊断或点击播放按钮重试。';
}
