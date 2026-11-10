import assert from 'node:assert/strict';
import test from 'node:test';
import { rootCertificates } from 'node:tls';
import { companyReleaseProfile, releaseBaseUrl, windowsUpdateFeed } from './daocut-release-config.mjs';

test('updates remain off unless a company feed is explicitly supplied', () => {
  assert.equal(releaseBaseUrl(), '');
  assert.equal(windowsUpdateFeed('  '), null);
});

test('the generic Windows feed uses the company updates base', () => {
  assert.equal(windowsUpdateFeed(' https://updates.example.test/updates/// '), 'https://updates.example.test/updates/win/x64');
});

test('a packaged feed cannot contain credentials or bypass HTTPS', () => {
  for (const value of ['http://updates.example.test', '/updates', 'https://user:secret@updates.example.test', 'https://updates.example.test?token=secret', 'https://updates.example.test#token']) {
    assert.throws(() => releaseBaseUrl(value), /HTTPS/);
  }
});

test('company profiles keep only documented public configuration', () => {
  assert.deepEqual(companyReleaseProfile({ name: ' Daotian ', serverUrl: 'https://company.example.test/', caPem: '' }), {
    name: 'Daotian', serverUrl: 'https://company.example.test', caPem: '',
  });
  for (const profile of [null, {}, { name: 'Daotian', serverUrl: 'https://company.example.test/path', caPem: '' }, { name: 'Daotian', serverUrl: 'https://company.example.test', caPem: '', token: 'private' },
    { name: 'Daotian', serverUrl: 'https://company.example.test', caPem: '-----BEGIN PRIVATE KEY-----secret-----END PRIVATE KEY-----' },
    { name: 'Daotian', serverUrl: 'https://company.example.test', caPem: '-----BEGIN CERTIFICATE-----invalid-----END CERTIFICATE-----' }]) {
    assert.throws(() => companyReleaseProfile(profile));
  }
});

test('company profiles accept a single public service certificate', () => {
  const caPem = rootCertificates[0];
  const profile = companyReleaseProfile({ name: 'Daotian', serverUrl: 'https://company.example.test', caPem });
  assert.equal(profile.caPem, caPem.trim());
  assert.throws(() => companyReleaseProfile({ ...profile, caPem: rootCertificates.slice(0, 2).join('\n') }), /one public PEM/);
});
