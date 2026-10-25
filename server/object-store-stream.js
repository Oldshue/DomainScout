'use strict';
const { createHash } = require('node:crypto');
const { addAbortSignal } = require('node:stream');
const { PutObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const MiB = 1024 * 1024;

// Sequential multipart uploads apply backpressure and retain one part in memory.
// Known-length callers select a part size that fits the provider's 10,000-part
// bound; unknown-length callers can supply partBytes for their capacity budget.
async function uploadObjectStream({ client, bucket, key, input, contentType = 'application/octet-stream', signal, expectedBytes, partBytes }) {
  const size = partBytes ?? Math.max(8 * MiB, expectedBytes == null ? 0 : Math.ceil(expectedBytes / 10000));
  if (!Number.isSafeInteger(size) || size < 5 * MiB || size > 5 * 1024 * MiB || (expectedBytes != null && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0))) throw Error('Invalid multipart upload capacity');
  if (signal) addAbortSignal(signal, input);
  const request = command => client.send(command, { abortSignal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000) });
  const hash = createHash('sha256'), parts = [];
  let uploadId, bytes = 0, used = 0;
  const buffer = Buffer.allocUnsafe(size);
  async function uploadPart(body) {
    signal?.throwIfAborted();
    if (!uploadId) uploadId = (await request(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: contentType }))).UploadId;
    if (!uploadId) throw Error('Object store omitted multipart upload identity');
    if (parts.length >= 10000) throw Error('Object store multipart part limit reached; increase partBytes or provide expectedBytes');
    const PartNumber = parts.length + 1;
    const result = await request(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber, Body: body, ContentLength: body.length }));
    if (!result.ETag) throw Error('Object store omitted multipart part receipt');
    parts.push({ PartNumber, ETag: result.ETag });
  }
  try {
    for await (const value of input) {
      signal?.throwIfAborted();
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      hash.update(chunk); bytes += chunk.length;
      let offset = 0;
      while (offset < chunk.length) {
        const length = Math.min(size - used, chunk.length - offset);
        chunk.copy(buffer, used, offset, offset + length); used += length; offset += length;
        if (used === size) { await uploadPart(buffer); used = 0; }
      }
    }
    signal?.throwIfAborted();
    if (expectedBytes != null && bytes !== expectedBytes) throw Error('Upload input byte count does not match expectedBytes');
    if (uploadId) {
      if (used) await uploadPart(buffer.subarray(0, used));
      await request(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
    } else await request(new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer.subarray(0, used), ContentType: contentType }));
    return { key, bytes, sha256: hash.digest('hex') };
  } catch (error) {
    input.destroy();
    if (uploadId) await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }), { abortSignal: AbortSignal.timeout(30000) }).catch(() => {});
    throw error;
  }
}
async function* listObjectMetadata({ client, bucket, prefix, signal }) {
  let cursor;
  const visited = new Set();
  for (;;) {
    const response = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(cursor ? { ContinuationToken: cursor } : {}) }), { abortSignal: signal || AbortSignal.timeout(120000) });
    for (const item of response.Contents || []) {
      if (typeof item.Key !== 'string' || !item.Key.startsWith(prefix) || !Number.isSafeInteger(item.Size) || item.Size < 0) throw Error('Object listing escaped its requested prefix or omitted byte count');
      yield { key: item.Key, bytes: item.Size, etag: item.ETag || null };
    }
    if (!response.IsTruncated) break;
    const next = response.NextContinuationToken;
    if (typeof next !== 'string' || !next || visited.has(next)) throw Error('Object listing cursor did not advance');
    visited.add(next); cursor = next;
  }
}
module.exports = { uploadObjectStream, listObjectMetadata };
