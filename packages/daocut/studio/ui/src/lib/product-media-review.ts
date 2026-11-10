import { sourceTime } from './product-analysis.ts';

export interface ProductMediaReview {
  version: 'product-media-review-v1'; key?: string; status: 'complete' | 'failed';
  scope: { startMs: number; endMs: number };
  segments: {
    startMs: number; endMs: number; cueRange?: [number, number];
    visual: { status: 'sampled' | 'unavailable'; sampleTimesMs: number[] };
    audio: { status: 'technical-checked' | 'unavailable'; hasAudio?: boolean; peakDb?: number; integratedLufs?: number; measurementRange?: { startMs: number; endMs: number } };
    issues: string[];
  }[];
  issues: string[]; speechVerified: false; continuousActionVerified: false;
}

/** A presentation of saved tool output, never an instruction to analyse again. */
export function mediaReviewPresentation(review: ProductMediaReview | null | undefined, origin: 'shared' | 'local' | 'saved' = 'shared') {
  if (!review) return {
    summary: '音画核查：未保存记录', range: '', originLabel: '', rangeLabel: '', note: '沿用已有文字结果，未自动补查音画。',
    issues: [] as string[], segments: [] as { range: string; visual: string; audio: string; issues: string[] }[],
  };
  return {
    summary: review.status === 'complete' ? '音画工具结果已保存' : '音画工具检查未完成',
    range: `${sourceTime(review.scope.startMs)}–${sourceTime(review.scope.endMs)}`,
    originLabel: origin === 'local' ? '本机补查记录，未改公共底稿' : origin === 'saved' ? '当前工程已保存的音画记录' : '复用公共音画记录',
    rangeLabel: origin === 'local' ? '本机检查范围' : origin === 'saved' ? '原片范围' : '公共记录范围',
    note: '抽帧供画面核对，连续动作未核实；波形和响度是技术检查，原音未核听。',
    issues: review.issues,
    segments: review.segments.map(segment => {
      const metrics = [
        ...(Number.isFinite(segment.audio.peakDb) ? [`峰值 ${segment.audio.peakDb} dB`] : []),
        ...(Number.isFinite(segment.audio.integratedLufs) ? [`综合响度 ${segment.audio.integratedLufs} LUFS`] : []),
      ];
      const measurement = segment.audio.measurementRange;
      const measurementLabel = measurement ? `本次讲解整体测量（${sourceTime(measurement.startMs)}–${sourceTime(measurement.endMs)}）` : '测量范围未记录';
      return {
        range: `${sourceTime(segment.startMs)}–${sourceTime(segment.endMs)}`,
        visual: segment.visual.status === 'sampled' && segment.visual.sampleTimesMs.length
          ? `画面抽帧：${segment.visual.sampleTimesMs.length} 个时刻（${segment.visual.sampleTimesMs.map(sourceTime).join('、')}）`
          : '画面：未取得抽帧',
        audio: segment.audio.status !== 'technical-checked' ? '音频技术检查：未完成'
          : `音频技术检查：${measurementLabel} · ${segment.audio.hasAudio === false ? '未检出音轨' : metrics.length ? metrics.join(' · ') : '已完成波形检查'}`,
        issues: segment.issues,
      };
    }),
  };
}
