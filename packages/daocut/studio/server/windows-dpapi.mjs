import { spawn } from 'node:child_process';
import { join, isAbsolute } from 'node:path';

const SCRIPT = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $b=[Convert]::FromBase64String($s); $p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($p))";

// Explicitly invoked only by a trusted local caller. No shell, file, or network access.
export async function unprotectCurrentUser(ciphertext) {
  if (process.platform !== 'win32' || !Buffer.isBuffer(ciphertext) || !ciphertext.length || ciphertext.length > 65536) throw new Error('本机安全存储不可用');
  try {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot || !isAbsolute(systemRoot)) throw Error();
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return await new Promise((resolve, reject) => {
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, shell: false });
      let output = '', settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); if (error) { child.kill(); reject(error); } else resolve(value); };
      const timer = setTimeout(() => finish(Error()), 10000);
      child.on('error', () => finish(Error()));
      child.stdin.on('error', () => finish(Error()));
      child.stdout.on('error', () => finish(Error()));
      child.stdout.on('data', chunk => { output += chunk.toString('ascii'); if (output.length > 131072) finish(Error()); });
      child.on('close', code => {
        if (code !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(output)) return finish(Error());
        finish(null, Buffer.from(output, 'base64'));
      });
      child.stdin.end(ciphertext.toString('base64'));
    });
  } catch { throw new Error('本机安全存储不可用'); }
}
