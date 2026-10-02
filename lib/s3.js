// S3-compatible object storage client (built for Cloudflare R2). SigV4 is
// hand-rolled on node:crypto so the dependency count stays at zero.
//
// Used by lib/backup.js (daily JSON bundle) and by the media layer
// (lib/media.js), where originals and previews live in the bucket and the
// Render disk only keeps a bounded cache. Browsers and the Mac sync script
// upload straight to the bucket through presigned URLs, so large files never
// pass through the app server.
//
// Env (the same four vars as backups; one bucket serves both):
//   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Optional: R2_ENDPOINT (any S3-compatible endpoint), R2_REGION (default
// "auto"), R2_MEDIA_PREFIX (default "media"), R2_BACKUP_PREFIX is handled in
// backup.js.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

// RFC 3986 percent-encoding, as SigV4 requires (encodeURIComponent leaves
// !'()* alone).
const uriEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const encodePath = (p) => p.split('/').map(uriEncode).join('/');

export function s3Config() {
  const accountId = process.env.R2_ACCOUNT_ID || '';
  return {
    accessKey: process.env.R2_ACCESS_KEY_ID || '',
    secretKey: process.env.R2_SECRET_ACCESS_KEY || '',
    bucket: process.env.R2_BUCKET || '',
    endpoint: process.env.R2_ENDPOINT || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : ''),
    region: process.env.R2_REGION || 'auto',
    mediaPrefix: (process.env.R2_MEDIA_PREFIX || 'media').replace(/^\/+|\/+$/g, ''),
  };
}

export const s3Configured = () => {
  const c = s3Config();
  return !!(c.accessKey && c.secretKey && c.bucket && c.endpoint);
};

const stamp = (date = new Date()) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

const signingKey = (secretKey, dateStamp, region) =>
  hmac(hmac(hmac(hmac(`AWS4${secretKey}`, dateStamp), region), 's3'), 'aws4_request');

const canonicalQuery = (query) =>
  Object.keys(query).sort().map((k) => `${uriEncode(k)}=${uriEncode(String(query[k]))}`).join('&');

// Query-string authentication (a presigned URL). Exported so the unit test
// can check the signing against AWS's published example.
export function presignCore({ method, host, pathname, query = {}, accessKey, secretKey, region, date, expires, protocol = 'https' }) {
  const amzDate = stamp(date);
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const q = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalRequest = [method, pathname, canonicalQuery(q), `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(secretKey, dateStamp, region)).update(stringToSign, 'utf8').digest('hex');
  return `${protocol}://${host}${pathname}?${canonicalQuery({ ...q, 'X-Amz-Signature': signature })}`;
}

function target(key) {
  const c = s3Config();
  const url = new URL(c.endpoint);
  return { c, url, pathname: `/${uriEncode(c.bucket)}/${encodePath(key)}`, bucketPath: `/${uriEncode(c.bucket)}` };
}

// A signed request using the Authorization header. Bodies are sent with
// UNSIGNED-PAYLOAD (safe over HTTPS) so large files can stream from disk.
async function signedFetch(method, key, { query = {}, body, headers = {}, bucketLevel = false, signal } = {}) {
  const { c, url, pathname, bucketPath } = target(key || '');
  const path = bucketLevel ? bucketPath : pathname;
  const amzDate = stamp();
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = 'UNSIGNED-PAYLOAD';
  const h = { host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  const signedHeaders = Object.keys(h).sort();
  const canonicalHeaders = signedHeaders.map((k) => `${k}:${String(h[k]).trim()}\n`).join('');
  const canonicalRequest = [method, path, canonicalQuery(query), canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${c.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const signature = crypto.createHmac('sha256', signingKey(c.secretKey, dateStamp, c.region)).update(stringToSign, 'utf8').digest('hex');
  const send = { ...h };
  delete send.host;
  send.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKey}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
  const qs = canonicalQuery(query);
  const init = { method, headers: send, signal };
  if (body !== undefined && body !== null) {
    init.body = body;
    if (body instanceof Readable || (body && typeof body.pipe === 'function')) init.duplex = 'half';
  }
  return fetch(`${url.origin}${path}${qs ? `?${qs}` : ''}`, init);
}

async function must(res, what) {
  if (res.ok) return res;
  const text = await res.text().catch(() => '');
  throw new Error(`r2 ${what} failed ${res.status}: ${text.slice(0, 300)}`);
}

// ---- objects --------------------------------------------------------------

export async function putObject(key, body, contentType = 'application/octet-stream') {
  const len = Buffer.isBuffer(body) ? body.length : undefined;
  const res = await signedFetch('PUT', key, {
    body,
    headers: { 'content-type': contentType, ...(len !== undefined ? { 'content-length': String(len) } : {}) },
  });
  await must(res, `put ${key}`);
  return { key, etag: res.headers.get('etag') };
}

// Streams a file from disk into the bucket (single request up to 5GB; the
// migration path uses multipart for anything larger).
export async function putFile(key, file, contentType = 'application/octet-stream') {
  const size = fs.statSync(file).size;
  const res = await signedFetch('PUT', key, {
    body: fs.createReadStream(file),
    headers: { 'content-type': contentType, 'content-length': String(size) },
  });
  await must(res, `put ${key}`);
  return { key, size, etag: res.headers.get('etag') };
}

// Streams a readable (an incoming HTTP request, say) into the bucket as one
// object. The size must be known up front.
export async function putStream(key, readable, size, contentType = 'application/octet-stream') {
  const res = await signedFetch('PUT', key, {
    body: readable,
    headers: { 'content-type': contentType, 'content-length': String(size) },
  });
  await must(res, `put ${key}`);
  return { key, size, etag: res.headers.get('etag') };
}

export const getObjectResponse = (key, range) =>
  signedFetch('GET', key, { headers: range ? { range } : {} });

export async function getObjectBuffer(key) {
  const res = await getObjectResponse(key);
  if (res.status === 404) return null;
  await must(res, `get ${key}`);
  return Buffer.from(await res.arrayBuffer());
}

// Streams an object to a local file (atomic via .part), returns bytes.
export async function getObjectToFile(key, file) {
  const res = await getObjectResponse(key);
  if (res.status === 404) return null;
  await must(res, `get ${key}`);
  const part = `${file}.part`;
  const out = fs.createWriteStream(part);
  let bytes = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body)) {
      bytes += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    }
    await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
    fs.renameSync(part, file);
  } catch (err) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw err;
  }
  return bytes;
}

export async function headObject(key) {
  const res = await signedFetch('HEAD', key);
  if (res.status === 404) return null;
  await must(res, `head ${key}`);
  return { size: Number(res.headers.get('content-length') || 0), etag: res.headers.get('etag'), type: res.headers.get('content-type') };
}

export async function deleteObject(key) {
  const res = await signedFetch('DELETE', key);
  if (res.status === 404) return;
  await must(res, `delete ${key}`);
}

export async function listObjects(prefix, { max = 1000 } = {}) {
  const out = [];
  let token = null;
  do {
    const query = { 'list-type': '2', prefix, 'max-keys': String(Math.min(max, 1000)), ...(token ? { 'continuation-token': token } : {}) };
    const res = await signedFetch('GET', '', { query, bucketLevel: true });
    await must(res, `list ${prefix}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const k = /<Key>([\s\S]*?)<\/Key>/.exec(m[1])?.[1];
      const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] || 0);
      if (k) out.push({ key: k.replace(/&amp;/g, '&'), size });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] : null;
  } while (token && out.length < max);
  return out;
}

// ---- presigned URLs -------------------------------------------------------

export function presign(method, key, { expires = 3600, query = {} } = {}) {
  const { c, url, pathname } = target(key);
  return presignCore({
    method, host: url.host, pathname, query,
    accessKey: c.accessKey, secretKey: c.secretKey, region: c.region,
    date: new Date(), expires, protocol: url.protocol.replace(':', ''),
  });
}

// ---- multipart uploads (originals up to hundreds of GB) --------------------

export async function createMultipart(key, contentType = 'application/octet-stream') {
  const res = await signedFetch('POST', key, { query: { uploads: '' }, headers: { 'content-type': contentType } });
  await must(res, `multipart create ${key}`);
  const xml = await res.text();
  const uploadId = /<UploadId>([\s\S]*?)<\/UploadId>/.exec(xml)?.[1];
  if (!uploadId) throw new Error('r2 multipart create returned no upload id');
  return uploadId;
}

export const presignPart = (key, uploadId, partNumber, expires = 6 * 3600) =>
  presign('PUT', key, { expires, query: { partNumber: String(partNumber), uploadId } });

export async function completeMultipart(key, uploadId, parts) {
  const body = `<CompleteMultipartUpload>${parts
    .slice().sort((a, b) => a.n - b.n)
    .map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('')}</CompleteMultipartUpload>`;
  const res = await signedFetch('POST', key, { query: { uploadId }, body: Buffer.from(body), headers: { 'content-type': 'application/xml' } });
  await must(res, `multipart complete ${key}`);
  const xml = await res.text();
  if (/<Error>/.test(xml)) throw new Error(`r2 multipart complete failed: ${xml.slice(0, 300)}`);
  return true;
}

export async function abortMultipart(key, uploadId) {
  const res = await signedFetch('DELETE', key, { query: { uploadId } });
  if (res.status !== 404) await must(res, `multipart abort ${key}`);
}

// Parts already stored for an in-progress multipart upload, so a dropped
// connection resumes instead of restarting a 2GB video.
export async function listParts(key, uploadId) {
  const out = [];
  let marker = null;
  do {
    const query = { uploadId, 'max-parts': '1000', ...(marker ? { 'part-number-marker': marker } : {}) };
    const res = await signedFetch('GET', key, { query });
    if (res.status === 404) return null;
    await must(res, `multipart list ${key}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Part>([\s\S]*?)<\/Part>/g)) {
      const n = Number(/<PartNumber>(\d+)<\/PartNumber>/.exec(m[1])?.[1]);
      const etag = /<ETag>([\s\S]*?)<\/ETag>/.exec(m[1])?.[1];
      const size = Number(/<Size>(\d+)<\/Size>/.exec(m[1])?.[1] || 0);
      if (n) out.push({ n, etag: etag?.replace(/&quot;/g, '"'), size });
    }
    marker = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? /<NextPartNumberMarker>(\d+)<\/NextPartNumberMarker>/.exec(xml)?.[1] : null;
  } while (marker);
  return out;
}
