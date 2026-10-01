// IndexNow: tell participating search engines (Bing, Yandex, Seznam, Naver
// and others; Google does not use it) that a URL is new or changed, so the
// fresh version is what gets crawled and cited. Ownership is proven by a key
// file the site itself serves at /<key>.txt, so this module first confirms
// that file is live and only then submits. Zero model tokens.

import crypto from 'node:crypto';
import { fetchHtml } from './crawl.js';

const ENDPOINT = 'https://api.indexnow.org/indexnow';

export const newIndexNowKey = () => crypto.randomBytes(16).toString('hex');

export async function submitIndexNow(rawUrl, key) {
  const checkedAt = new Date().toISOString();
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return { status: 'skipped', reason: 'not a valid URL', checkedAt };
  }
  const keyLocation = `${url.protocol}//${url.host}/${key}.txt`;
  try {
    const file = await fetchHtml(keyLocation);
    if (file.status !== 200 || file.html.trim() !== key) {
      return {
        status: 'key_file_missing', keyLocation, checkedAt,
        reason: `The key file is not live yet. Add ${keyLocation} to the site (the Site setup kit explains how), then re-save this URL.`,
      };
    }
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: url.host, key, keyLocation, urlList: [url.toString()] }),
      signal: AbortSignal.timeout(10000),
    });
    // 200 and 202 both mean the submission was accepted.
    if (res.status === 200 || res.status === 202) return { status: 'submitted', httpStatus: res.status, keyLocation, checkedAt };
    return { status: 'rejected', httpStatus: res.status, keyLocation, checkedAt, reason: `IndexNow answered HTTP ${res.status}` };
  } catch (err) {
    return { status: 'error', checkedAt, reason: String(err.message || err).slice(0, 160) };
  }
}
