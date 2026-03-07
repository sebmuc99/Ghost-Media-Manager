'use strict';

/**
 * server/lib/ghost.js
 * All Ghost Admin API interactions.
 * GHOST_URL is always read from process.env internally.
 */

const fetch    = require('node-fetch');
const FormData = require('form-data');
const jwt      = require('jsonwebtoken');

// ── makeGhostToken ────────────────────────────────────────────────────────────
function makeGhostToken(apiKey) {
  const [id, secret] = apiKey.split(':');
  if (!id || !secret) throw new Error('Invalid API key format');
  return jwt.sign({}, Buffer.from(secret, 'hex'), {
    keyid: id, algorithm: 'HS256', expiresIn: '5m', audience: '/admin/',
  });
}

// ── ghostRequest ──────────────────────────────────────────────────────────────
// Base fetch wrapper.
//   - Reads GHOST_URL from process.env
//   - Injects JWT Authorization header
//   - 15-second timeout (fixes E1)
//   - Merges caller-supplied headers so FormData boundary is preserved
async function ghostRequest(apiKey, endpoint, options = {}) {
  const GHOST_URL = (process.env.GHOST_URL || '').replace(/\/$/, '');
  if (!GHOST_URL) throw new Error('GHOST_URL not configured on server');

  const token = makeGhostToken(apiKey);
  const url   = `${GHOST_URL}/ghost/api/admin${endpoint}`;

  return fetch(url, {
    signal: AbortSignal.timeout(15000),
    ...options,
    headers: {
      Authorization:    `Ghost ${token}`,
      'Accept-Version': 'v5.0',
      ...(options.headers || {}),
    },
  });
}

// ── ghostFetchAll ─────────────────────────────────────────────────────────────
// Paginated fetch replacing the 5 inline pagination loops.
// type    : Ghost resource name, e.g. 'posts', 'pages', 'tags'
// fields  : comma-separated field string passed to ?fields=
// opts    : { formats, include, extraQuery }
//             formats    — e.g. 'lexical' or 'html,lexical'
//             include    — e.g. 'tags'
//             extraQuery — raw query string fragment appended verbatim
// Returns: flat array of all items across all pages.
async function ghostFetchAll(apiKey, type, fields, opts = {}) {
  const { formats, include, extraQuery } = opts;
  const items = [];
  let page = 1, totalPages = 1;

  while (page <= totalPages) {
    let qs = `page=${page}&limit=100`;
    if (fields)     qs += `&fields=${encodeURIComponent(fields)}`;
    if (formats)    qs += `&formats=${encodeURIComponent(formats)}`;
    if (include)    qs += `&include=${encodeURIComponent(include)}`;
    if (extraQuery) qs += `&${extraQuery}`;

    const r = await ghostRequest(apiKey, `/${type}/?${qs}`);
    if (!r.ok) break;

    const data = await r.json();
    const list = data[type] || [];
    items.push(...list);
    totalPages = data.meta?.pagination?.pages || 1;
    page++;
    // Safety break: Ghost returned empty page before totalPages was reached
    if (list.length === 0) break;
  }

  return items;
}

// ── getPost ───────────────────────────────────────────────────────────────────
// Fetch a single post/page with full content.
// type: 'posts' | 'pages'
// Returns the post object or null.
async function getPost(apiKey, type, postId) {
  const FIELDS = 'id,title,slug,url,status,excerpt,custom_excerpt,feature_image,lexical,html,meta_title,meta_description,updated_at,published_at';
  const r = await ghostRequest(apiKey, `/${type}/${postId}/?fields=${encodeURIComponent(FIELDS)}&formats=lexical&include=tags`);
  if (!r.ok) return null;
  const data = await r.json();
  return (data[type] || [])[0] || null;
}

// ── updatePost ────────────────────────────────────────────────────────────────
// PUT a post/page update.
// payload must include { updated_at }.
// On 409 Conflict: re-fetches updated_at and retries once automatically.
// Returns the fetch Response from the final attempt.
async function updatePost(apiKey, type, postId, payload) {
  const doUpdate = (p) =>
    ghostRequest(apiKey, `/${type}/${postId}/`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ [type]: [p] }),
    });

  let r = await doUpdate(payload);

  if (r.status === 409) {
    // Conflict — another update happened; re-fetch current updated_at and retry once
    const fresh = await getPost(apiKey, type, postId);
    if (fresh) {
      r = await doUpdate({ ...payload, updated_at: fresh.updated_at });
    }
  }

  return r;
}

// ── uploadImage ───────────────────────────────────────────────────────────────
// Upload a buffer to /ghost/api/admin/images/upload/
// Returns the raw fetch Response.
async function uploadImage(apiKey, buffer, filename, mimeType) {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimeType || 'image/jpeg' });
  form.append('purpose', 'image');
  return ghostRequest(apiKey, '/images/upload/', {
    method:  'POST',
    body:    form,
    headers: form.getHeaders(),
  });
}

// ── uploadMedia ───────────────────────────────────────────────────────────────
// Upload a buffer to /ghost/api/admin/media/upload/
// thumbBuffer/thumbFilename are optional (for video thumbnails).
// Returns the raw fetch Response.
async function uploadMedia(apiKey, buffer, filename, mimeType, thumbBuffer, thumbFilename) {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimeType || 'application/octet-stream' });
  form.append('ref', filename);
  if (thumbBuffer && thumbFilename) {
    form.append('thumbnail', thumbBuffer, { filename: thumbFilename, contentType: 'image/jpeg' });
  }
  return ghostRequest(apiKey, '/media/upload/', {
    method:  'POST',
    body:    form,
    headers: form.getHeaders(),
  });
}

// ── uploadFile ────────────────────────────────────────────────────────────────
// Upload a buffer to /ghost/api/admin/files/upload/
// Returns the raw fetch Response.
async function uploadFile(apiKey, buffer, filename, mimeType) {
  const form = new FormData();
  form.append('file', buffer, { filename, contentType: mimeType || 'application/octet-stream' });
  return ghostRequest(apiKey, '/files/upload/', {
    method:  'POST',
    body:    form,
    headers: form.getHeaders(),
  });
}

// ── getGhostLang ──────────────────────────────────────────────────────────────
// Fetch the Ghost site publication language from /ghost/api/admin/settings/.
// Result is cached in memory for 1 hour (publication language rarely changes).
// Falls back to 'en' if the API call fails or the field is absent.
let _settingsCache = null;
let _settingsCacheTime = 0;
const SETTINGS_CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function getGhostLang(apiKey) {
  const now = Date.now();
  if (_settingsCache && (now - _settingsCacheTime) < SETTINGS_CACHE_TTL) {
    return _settingsCache;
  }
  try {
    const r = await ghostRequest(apiKey, '/settings/');
    if (!r.ok) return 'en';
    const data = await r.json();
    const localeEntry = Array.isArray(data?.settings) ? data.settings.find(s => s.key === 'locale') : null;
    const lang = localeEntry?.value || data?.settings?.lang || 'en';
    _settingsCache = lang;
    _settingsCacheTime = now;
    return lang;
  } catch {
    return 'en';
  }
}

module.exports = {
  makeGhostToken,
  ghostRequest,
  ghostFetchAll,
  getPost,
  updatePost,
  uploadImage,
  uploadMedia,
  uploadFile,
  getGhostLang,
};
