import { readProductTranscript } from './product-transcription.mjs';
import { vttOf } from './transcripts.mjs';

/** Derive child/snapshot subtitles from verified ASR without changing the
 * source project or requesting transcription. Existing VTT takes precedence. */
export async function savedStructureTranscriptVtt(root, source) {
  const transcript = await readProductTranscript(root, source);
  return transcript?.cues?.length ? vttOf(transcript.cues) : null;
}
