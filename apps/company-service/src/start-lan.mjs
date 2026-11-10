import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCompanyService } from './service.mjs';
const dataDir = path.resolve(process.env.DAOCUT_COMPANY_DATA || 'D:/Daocut/CompanyData');
const configPath = path.join(dataDir, 'server-config.json');
let config;
try { config = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) { throw new Error(`无法读取 ${configPath}，请先运行 setup:lan。`, { cause: error }); }
const tls = { key: await readFile(config.keyPath), cert: await readFile(config.certPath), minVersion: 'TLSv1.2' };
const service = await createCompanyService({ dataDir, host: config.host, port: config.port, baseURL: config.baseURL, tls });
await service.listen();
console.log(`Daocut 公司服务 ${service.baseURL}`);
console.log(`本机管理台 https://localhost:${config.port}/admin`);
console.log(`数据目录 ${service.dataDir}`);
console.log('首次运行请在服务器电脑的本机管理台设置管理员账号和密码。');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
