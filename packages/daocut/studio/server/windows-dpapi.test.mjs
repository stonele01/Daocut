import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { unprotectCurrentUser } from './windows-dpapi.mjs';

test('current-user DPAPI round trip uses only synthetic bytes', { skip: process.platform !== 'win32' }, async () => {
  const script = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))";
  const original = Buffer.from('synthetic-only');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: original.toString('base64'), encoding: 'utf8', windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'ignore'] });
  assert.equal(result.status, 0);
  assert.deepEqual(await unprotectCurrentUser(Buffer.from(result.stdout, 'base64')), original);
  await assert.rejects(unprotectCurrentUser(Buffer.from('invalid synthetic ciphertext')), { message: '本机安全存储不可用' });
});

test('rejects invalid inputs without exposing them', async () => {
  await assert.rejects(unprotectCurrentUser(Buffer.alloc(0)), { message: '本机安全存储不可用' });
  await assert.rejects(unprotectCurrentUser(Buffer.alloc(65537)), { message: '本机安全存储不可用' });
});
