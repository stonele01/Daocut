// A cheap, read-only check using the same film reader as Studio and rendering.
// It does not open Studio, probe media, draw frames or make an API request.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FILM_FILE, readFilmFile } from './film-doc.mjs';
import { locate } from './shared.mjs';

export function check(args = []) {
  if (args.length > 1) return { ok: false, usage: true, lines: ['daocut check: give one project folder or film.html.'] };
  const loc = locate(args[0] ?? '.');
  if (!loc.isFilm) return { ok: false, usage: true, lines: ['daocut check: give a project folder or film.html, not a scene page.'] };
  const { doc, problems } = readFilmFile(readFileSync(join(loc.dir, FILM_FILE), 'utf8'));
  if (!doc) return { ok: false, lines: problems };
  const clips = doc.tracks.reduce((sum, track) => sum + track.clips.length, 0);
  return { ok: true, lines: [
    `OK: ${FILM_FILE} — ${clips} clips, ${doc.tracks.length} tracks; timeline syntax and numeric ranges are valid.`,
    'Media availability, source duration, spoken cuts and visual output were not checked. Use daocut look for the picture and mix.',
  ] };
}
