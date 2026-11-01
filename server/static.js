import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.xml': 'application/xml',
};

/** Serve files under root for a URL path, with Range support (video) and weak ETags. Returns false if not found. */
export async function serveStatic(root, urlPath, req, res) {
  const rootAbs = path.resolve(root);
  const safe = path.normalize(decodeURIComponent(urlPath)).replace(/^([.][.][/\\])+/, '');
  let file = path.join(rootAbs, safe);
  if (!file.startsWith(rootAbs)) { res.writeHead(403).end(); return true; }
  let st;
  try {
    st = await stat(file);
    if (st.isDirectory()) { file = path.join(file, 'index.html'); st = await stat(file); }
  } catch { return false; }
  const etag = `W/"${st.size}-${Number(st.mtimeMs).toString(36)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return true; }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, etag, 'accept-ranges': 'bytes', 'cache-control': 'no-cache' };
  const range = req.headers['range']?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
    headers['content-length'] = end - start + 1;
    res.writeHead(206, headers);
    createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  headers['content-length'] = st.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') res.end(); else createReadStream(file).pipe(res);
  return true;
}
