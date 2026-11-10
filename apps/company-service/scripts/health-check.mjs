import https from 'node:https';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
try {
  const dataDir = process.argv[2];
  const config = JSON.parse(await readFile(path.join(dataDir, 'server-config.json'), 'utf8'));
  const ca = await readFile(config.certPath, 'utf8');
  const result = await new Promise((resolve, reject) => {
    const request = https.get(`https://127.0.0.1:${config.port}/api/company/health`, { ca, rejectUnauthorized: true, agent: false }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; if (body.length > 4096) response.destroy(new Error('Response too large')); });
      response.on('error', reject);
      response.on('end', () => { try { const data = JSON.parse(body); if (response.statusCode !== 200 || data.ok !== true || data.service !== 'Daocut Company') throw new Error('Unexpected service'); resolve(data); } catch (error) { reject(error); } });
    });
    request.setTimeout(1500, () => request.destroy(new Error('Health check timeout')));
    request.on('error', reject);
  });
  console.log(JSON.stringify(result));
} catch { process.exitCode = 1; }
