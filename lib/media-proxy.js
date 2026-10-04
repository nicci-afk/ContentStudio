// Loopback range proxy for ffmpeg. The static ffmpeg build the app ships
// (@ffmpeg-installer) segfaults when it has to resolve a hostname itself, and
// reading a 4K original through a signed URL would otherwise need exactly
// that. So ffmpeg is handed http://127.0.0.1:<port>/<token> (an IP literal, no
// DNS, no TLS inside ffmpeg) and this tiny server forwards each Range request
// to the bucket with the app's own credentials. A render therefore transfers
// only the windows of each clip it uses, and the signed URL never leaves the
// process. It listens on loopback only and tokens are random per process.

import http from 'node:http';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { getObjectResponse, headObject, s3Configured } from './s3.js';

const tokens = new Map(); // token -> object key
const byKey = new Map();  // object key -> token
let port = 0;

const server = http.createServer(async (req, res) => {
  try {
    const key = tokens.get(String(req.url || '').split('?')[0].slice(1));
    if (!key) { res.writeHead(404); return res.end(); }
    if (req.method === 'HEAD') {
      const head = await headObject(key);
      if (!head) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'accept-ranges': 'bytes', 'content-length': String(head.size), 'content-type': head.type || 'application/octet-stream' });
      return res.end();
    }
    const upstream = await getObjectResponse(key, req.headers.range);
    if (upstream.status === 404) { res.writeHead(404); return res.end(); }
    if (!upstream.ok && upstream.status !== 206) { res.writeHead(502); return res.end(); }
    const headers = { 'accept-ranges': 'bytes', 'content-type': upstream.headers.get('content-type') || 'application/octet-stream' };
    for (const h of ['content-length', 'content-range']) if (upstream.headers.get(h)) headers[h] = upstream.headers.get(h);
    res.writeHead(upstream.status, headers);
    const body = Readable.fromWeb(upstream.body);
    res.on('close', () => body.destroy());
    body.on('error', () => res.destroy());
    body.pipe(res);
  } catch {
    if (!res.headersSent) res.writeHead(502);
    res.end();
  }
});

if (s3Configured()) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  port = server.address().port;
}

// A loopback URL for an object key, or null when the proxy is not running.
export function proxyUrl(key) {
  if (!port) return null;
  let token = byKey.get(key);
  if (!token) { token = crypto.randomBytes(16).toString('hex'); byKey.set(key, token); tokens.set(token, key); }
  return `http://127.0.0.1:${port}/${token}`;
}
