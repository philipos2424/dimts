import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';

test('Apple client secret is a short-lived ES256 JWT signed with the .p8 key', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  Object.assign(process.env, { PUBLIC_BASE_URL: 'https://dimts.example', APPLE_SIGNIN_SERVICE_ID: 'com.example.signin',
    INTEGRATION_ENCRYPTION_KEY: 'ab'.repeat(32),
    APPLE_TEAM_ID: 'TEAM123456', APPLE_KEY_ID: 'KEY1234567',
    // Vercel stores multi-line keys with literal \n sequences.
    APPLE_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).replace(/\n/g, '\n') });
  const { providerConfig, configuredProviders } = await import('./social-signin.js');
  assert.ok(configuredProviders().includes('apple'));
  const apple = providerConfig('apple');
  assert.equal(apple.redirect, 'https://dimts.example/oauth/signin/apple/callback');
  const [header, claims, signature] = apple.credentials.secret.split('.');
  const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString());
  assert.deepEqual(decode(header), { alg: 'ES256', kid: 'KEY1234567' });
  const body = decode(claims);
  assert.equal(body.iss, 'TEAM123456'); assert.equal(body.sub, 'com.example.signin'); assert.equal(body.aud, 'https://appleid.apple.com');
  assert.ok(body.exp - body.iat <= 300);
  assert.ok(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')));
});
