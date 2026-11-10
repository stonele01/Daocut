#!/usr/bin/env node
// @ts-check
/**
 * product.json says where the desktop app looks for updates. Both checked-in profiles leave it empty, so packing
 * Daocut or using the legacy --official build cannot silently subscribe to another product's update channel.
 * product.official.json and the command name remain for compatibility with prepack and the older desktop script.
 * Company installers receive their explicit update URL through apps/desktop/scripts/build-daocut.mjs --updates.
 *
 *   node scripts/product.mjs official   (prepack) keeps product.json aside and writes the no-feed package profile
 *   node scripts/product.mjs restore    (postpack) puts the kept product.json back
 */
import { copyFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PRODUCT = join(ROOT, 'product.json');
const OFFICIAL = join(ROOT, 'product.official.json');
/* .dev/ is git-ignored and not in the package */
const KEPT = join(ROOT, '.dev', 'product.json.kept');

const step = process.argv[2];
if (step === 'official') {
  mkdirSync(join(ROOT, '.dev'), { recursive: true });
  /* a pack that stopped half-way left the checkout's own file aside: keep that one, not the package copy */
  if (!existsSync(KEPT)) copyFileSync(PRODUCT, KEPT);
  copyFileSync(OFFICIAL, PRODUCT);
} else if (step === 'restore') {
  if (existsSync(KEPT)) renameSync(KEPT, PRODUCT);
} else {
  console.error('Usage: node scripts/product.mjs official | restore');
  process.exit(2);
}
