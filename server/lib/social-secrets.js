import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function socialEncryptionKey() {
  const key = process.env.INTEGRATION_ENCRYPTION_KEY ?? '';
  if (!/^[a-f0-9]{64}$/i.test(key)) throw new Error('Set INTEGRATION_ENCRYPTION_KEY for Apple sign-in');
  return Buffer.from(key, 'hex');
}

export function sealAppleToken(token, subjectHash) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', socialEncryptionKey(), iv);
  cipher.setAAD(Buffer.from(`dimts:apple:${subjectHash}`));
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('hex'), cipher.getAuthTag().toString('hex'), body.toString('hex')].join('.');
}

export function openAppleToken(envelope, subjectHash) {
  const [version, iv, tag, body, extra] = envelope.split('.');
  if (version !== 'v1' || extra || !/^[a-f0-9]{24}$/.test(iv) || !/^[a-f0-9]{32}$/.test(tag) || !/^(?:[a-f0-9]{2})+$/.test(body)) {
    throw new Error('Invalid Apple credential envelope');
  }
  const decipher = createDecipheriv('aes-256-gcm', socialEncryptionKey(), Buffer.from(iv, 'hex'));
  decipher.setAAD(Buffer.from(`dimts:apple:${subjectHash}`));
  decipher.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'hex')), decipher.final()]).toString('utf8');
}
