import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const scratchRoot = fileURLToPath(new URL('../../../.tmp/', import.meta.url));

test('checked-in package profiles have no implicit desktop update feed', () => {
  for (const filename of ['product.json', 'product.official.json']) {
    const product = JSON.parse(readFileSync(join(packageRoot, filename), 'utf8'));
    assert.equal(product.desktop.updates, '', filename);
  }
});

test('prepack uses the no-feed profile and restores the original product after a repeated prepack', (t) => {
  mkdirSync(scratchRoot, { recursive: true });
  const fixture = mkdtempSync(join(scratchRoot, 'product-profile-'));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, 'scripts'));
  copyFileSync(join(packageRoot, 'scripts', 'product.mjs'), join(fixture, 'scripts', 'product.mjs'));
  copyFileSync(join(packageRoot, 'product.official.json'), join(fixture, 'product.official.json'));
  const original = '{"desktop":{"updates":"https://fixture.example.test/updates"},"fixture":true}\n';
  const productFile = join(fixture, 'product.json');
  writeFileSync(productFile, original);
  const step = (name) => execFileSync(process.execPath, [join(fixture, 'scripts', 'product.mjs'), name], {
    cwd: fixture, stdio: 'pipe', windowsHide: true,
  });

  step('official');
  assert.equal(JSON.parse(readFileSync(productFile, 'utf8')).desktop.updates, '');
  step('official');
  step('restore');
  assert.equal(readFileSync(productFile, 'utf8'), original);
  assert.equal(existsSync(join(fixture, '.dev', 'product.json.kept')), false);
  step('restore');
  assert.equal(readFileSync(productFile, 'utf8'), original);
});
