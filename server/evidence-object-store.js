'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { GetObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');

function cleanPrefix(value) {
  return String(value || '').replace(/^\/+|\/+$/g, '');
}

function evidenceObjectStoreConfig(env = process.env) {
  const config = {
    accessKeyId: String(env.DOMAINSCOUT_EVIDENCE_S3_ACCESS_KEY_ID || '').trim(),
    secretAccessKey: String(env.DOMAINSCOUT_EVIDENCE_S3_SECRET_ACCESS_KEY || '').trim(),
    bucket: String(env.DOMAINSCOUT_EVIDENCE_S3_BUCKET || '').trim(),
    endpoint: String(env.DOMAINSCOUT_EVIDENCE_S3_ENDPOINT || '').trim(),
    region: String(env.DOMAINSCOUT_EVIDENCE_S3_REGION || 'auto').trim(),
    prefix: cleanPrefix(env.DOMAINSCOUT_EVIDENCE_S3_PREFIX || 'domainscout/v1'),
    forcePathStyle: String(env.DOMAINSCOUT_EVIDENCE_S3_URL_STYLE || '').trim() === 'path',
  };
  config.configured = Boolean(
    config.accessKeyId && config.secretAccessKey && config.bucket && config.endpoint,
  );
  return config;
}

async function bodyBytes(body) {
  if (!body) return Buffer.alloc(0);
  if (typeof body.transformToByteArray === 'function') {
    return Buffer.from(await body.transformToByteArray());
  }
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function createEvidenceObjectStore({ env = process.env, client = null, now = () => new Date() } = {}) {
  const config = evidenceObjectStoreConfig(env);
  if (!config.configured) return null;
  const s3 = client || new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: config.forcePathStyle,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
  const objectKey = key => [config.prefix, cleanPrefix(key)].filter(Boolean).join('/');

  return Object.freeze({
    descriptor: Object.freeze({
      version: 1,
      provider: 's3-compatible',
      bucket: config.bucket,
      prefix: config.prefix,
      region: config.region,
    }),
    async putJson(key, value, { gzip = false, metadata = {} } = {}) {
      const plain = Buffer.from(JSON.stringify(value));
      const digest = crypto.createHash('sha256').update(plain).digest('hex');
      const body = gzip ? zlib.gzipSync(plain, { level: 9 }) : plain;
      const storedKey = objectKey(key);
      await s3.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: storedKey,
        Body: body,
        ContentType: 'application/json',
        ...(gzip ? { ContentEncoding: 'gzip' } : {}),
        Metadata: {
          sha256: digest,
          writtenat: now().toISOString(),
          ...Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)])),
        },
      }));
      return { key: storedKey, sha256: digest, bytes: plain.length, storedBytes: body.length };
    },
    async getJson(key) {
      try {
        const response = await s3.send(new GetObjectCommand({ Bucket: config.bucket, Key: objectKey(key) }));
        let bytes = await bodyBytes(response.Body);
        if (response.ContentEncoding === 'gzip') bytes = zlib.gunzipSync(bytes);
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        const expected = response.Metadata?.sha256;
        if (expected && expected !== digest) throw new Error(`Evidence digest mismatch for ${key}`);
        return { value: JSON.parse(bytes.toString('utf8')), sha256: digest, key: objectKey(key) };
      } catch (error) {
        if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
  });
}

module.exports = { createEvidenceObjectStore, evidenceObjectStoreConfig };
