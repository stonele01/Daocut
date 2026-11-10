import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import selfsigned from 'selfsigned';

export function lanAddresses() {
  return Object.entries(networkInterfaces()).flatMap(([name, entries]) => (entries || []).filter((entry) => entry.family === 'IPv4' && !entry.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address)).map((entry) => ({ name, address: entry.address })));
}
export async function setupLan({ dataDir = 'D:/Daocut/CompanyData', ip, port = 4715 }) {
  if (isIP(ip) !== 4) throw new Error('请使用服务器电脑的 IPv4 局域网地址');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('端口须为 1024–65535');
  const folder = path.resolve(dataDir);
  await mkdir(folder, { recursive: true });
  const keyPath = path.join(folder, 'server-key.pem');
  const certPath = path.join(folder, 'server-cert.pem');
  const configPath = path.join(folder, 'server-config.json');
  const profilePath = path.join(folder, 'Daocut-公司连接.json');
  const serverUrl = `https://${ip}:${port}`;
  let cert;
  try {
    cert = await readFile(certPath, 'utf8');
    await readFile(keyPath, 'utf8');
    const parsed = new X509Certificate(cert);
    if (!parsed.checkIP(ip) || !parsed.checkHost('localhost') || !parsed.checkIP('127.0.0.1')) throw new Error('现有证书与所选 IP 不符。请先备份数据目录，重新配置证书并向员工重新分发连接文件。');
    if (Date.parse(parsed.validTo) <= Date.now()) throw new Error('现有证书已过期，请先更新证书并重新分发连接文件。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const now = new Date();
    const pems = await selfsigned.generate([{ name: 'commonName', value: 'Daocut Company LAN' }], {
      keySize: 2048, algorithm: 'sha256', notBeforeDate: new Date(now.getTime() - 5 * 60_000), notAfterDate: new Date(now.getTime() + 365 * 24 * 60 * 60_000),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, ...[...new Set(['127.0.0.1', ip])].map((address) => ({ type: 7, ip: address }))] },
      ],
    });
    await writeFile(keyPath, pems.private, { flag: 'wx', mode: 0o600 });
    await writeFile(certPath, pems.cert, { flag: 'wx' });
    cert = pems.cert;
  }
  const config = { version: 1, dataDir: folder, host: '0.0.0.0', port, baseURL: serverUrl, keyPath, certPath };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  await writeFile(profilePath, `${JSON.stringify({ name: '稻田公司', serverUrl, caPem: cert }, null, 2)}\n`);
  return { configPath, profilePath, serverUrl, fingerprint: new X509Certificate(cert).fingerprint256 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2); const ipIndex = args.indexOf('--ip'); const dataIndex = args.indexOf('--data-dir'); const portIndex = args.indexOf('--port');
  let ip = ipIndex >= 0 ? args[ipIndex + 1] : undefined;
  const addresses = lanAddresses();
  if (!ip && addresses.length === 1) ip = addresses[0].address;
  if (!ip) {
    if (!stdin.isTTY || addresses.length === 0) throw new Error('请使用 --ip 指定这台电脑的局域网 IPv4 地址');
    console.log('请选择员工能访问的公司局域网网卡：');
    addresses.forEach((entry, index) => console.log(`${index + 1}. ${entry.name}  ${entry.address}`));
    const prompt = createInterface({ input: stdin, output: stdout });
    const answer = await prompt.question('网卡序号：'); prompt.close(); ip = addresses[Number(answer) - 1]?.address;
  }
  if (!addresses.some((entry) => entry.address === ip)) throw new Error('所选 IP 不是当前电脑的局域网地址，请检查网卡配置');
  const result = await setupLan({ ip, dataDir: dataIndex >= 0 ? args[dataIndex + 1] : process.env.DAOCUT_COMPANY_DATA, port: portIndex >= 0 ? Number(args[portIndex + 1]) : 4715 });
  console.log(`配置已生成：${result.configPath}`);
  console.log(`员工连接文件：${result.profilePath}`);
  console.log(`公司服务地址：${result.serverUrl}`);
  console.log(`证书 SHA-256：${result.fingerprint}`);
  console.log('仅分发员工连接文件，不要分发私钥、数据库或整个数据目录。');
  console.log('启动：npm --prefix apps/company-service run start:lan');
  console.log('本机初始化：https://localhost:4715（端口如有修改请对应替换）');
}

