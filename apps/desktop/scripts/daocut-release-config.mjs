import { X509Certificate } from 'node:crypto';

/** Release endpoints are public LAN addresses, never credential-bearing client URLs. */
export function releaseBaseUrl(value = '') {
  const text = value.trim();
  if (!text) return '';
  let url;
  try { url = new URL(text); } catch { throw new Error('The release address must be an absolute HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('The release address must use HTTPS without credentials, query parameters or fragments.');
  }
  return url.href.replace(/\/+$/, '');
}

export function windowsUpdateFeed(updates = '') {
  const base = releaseBaseUrl(updates);
  return base ? base + '/win/x64' : null;
}

/** Package only the public company profile, never arbitrary input-file fields. */
export function companyReleaseProfile(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !['name', 'serverUrl', 'caPem'].includes(key)) ||
      typeof value.name !== 'string' || !value.name.trim() || value.name.trim().length > 80 ||
      typeof value.serverUrl !== 'string' || !value.serverUrl.trim() ||
      typeof value.caPem !== 'string') {
    throw new Error('Company profile must contain only name, serverUrl and caPem strings.');
  }
  const serverUrl = releaseBaseUrl(value.serverUrl);
  if (new URL(serverUrl).pathname !== '/') throw new Error('Company profile serverUrl must be an HTTPS origin without a path.');
  const caPem = value.caPem.trim();
  if (caPem.length > 65536) throw new Error('Company profile caPem is too large.');
  if (caPem) {
    const certificates = caPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
    if (certificates.length !== 1 || caPem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g, '').trim()) {
      throw new Error('Company profile caPem must contain one public PEM service certificate, never a certificate bundle or private key.');
    }
    for (const certificate of certificates) new X509Certificate(certificate);
  }
  return { name: value.name.trim(), serverUrl, caPem };
}
