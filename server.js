'use strict';

require('dotenv').config();

const express  = require('express');
const multer   = require('multer');
const fetch    = require('node-fetch');
const FormData = require('form-data');
const jwt      = require('jsonwebtoken');
const path     = require('path');
const fs       = require('fs').promises;
const cors     = require('cors');
const helmet   = require('helmet');

const Anthropic    = require('@anthropic-ai/sdk');
const sharp        = require('sharp');
const { XMLParser } = require('fast-xml-parser');
const crypto        = require('crypto');
const os            = require('os');
const fsSync        = require('fs');

const ffmpeg        = require('fluent-ffmpeg');
const ffmpegPath    = require('ffmpeg-static');
const ffprobePath   = require('@ffprobe-installer/ffprobe').path;
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);
const rateLimit     = require('express-rate-limit');

const { replaceUrlInLexical, insertParagraphNodes, buildImageNode, insertImageNode, buildGalleryNode, insertGalleryNode } = require('./server/lib/lexical');
const { ghostRequest, ghostFetchAll, getPost, updatePost, uploadImage, uploadMedia, uploadFile, getGhostLang } = require('./server/lib/ghost');
const { walkContentDir, resolveContentPath, urlToContentPath } = require('./server/lib/filesystem');
const { portraitToLandscape, titleToFilename } = require('./server/lib/imageProcessing');

const aiExcerptLimiter      = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please try again later.' } });
const aiImproveLimiter      = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please try again later.' } });
const aiCreateLimiter       = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please try again later.' } });
const makeLandscapeLimiter  = rateLimit({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please try again later.' } });
const insertImageLimiter    = rateLimit({ windowMs: 60 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false, message: { error: 'Too many requests, please try again later.' } });

const app       = express();
const PORT      = process.env.PORT || 3334;
const GHOST_URL              = (process.env.GHOST_URL  || '').replace(/\/$/, '');
const IMMICH_URL             = (process.env.IMMICH_URL || '').replace(/\/$/, '');
const GHOST_MEDIA_PATH       = process.env.GHOST_MEDIA_PATH        || '/ghost-content/images';
const GHOST_MEDIA_VIDEO_PATH = process.env.GHOST_MEDIA_VIDEO_PATH  || '/ghost-content/media';
const GHOST_MEDIA_FILES_PATH = process.env.GHOST_MEDIA_FILES_PATH  || '/ghost-content/files';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const AI_MODEL_TEXT     = process.env.AI_MODEL_TEXT    || 'claude-haiku-4-5-20251001';
const AI_MODEL_VISION   = process.env.AI_MODEL_VISION  || 'claude-opus-4-6';
const AI_MODEL_CONTENT  = process.env.AI_MODEL_CONTENT || null; // falls back to AI_MODEL_TEXT if unset

// Lazy-init Anthropic client (only created when needed)
let _anthropicClient = null;
function getAnthropicClient() {
  if (!_anthropicClient) _anthropicClient = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  return _anthropicClient;
}

function logError(context, err) {
  console.error(JSON.stringify({
    ts:      new Date().toISOString(),
    context,
    error:   err?.message || String(err),
    ...(process.env.NODE_ENV !== 'production' && { stack: err?.stack }),
  }));
}

if (!GHOST_URL) {
  console.warn('[WARN] GHOST_URL is not set in .env â€“ all Ghost API calls will fail.');
}

// â”€â”€â”€ Security middleware â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'https://scaleflex.cloudimg.io', 'https://fonts.googleapis.com', "'unsafe-eval'"], // unsafe-eval required by Filerobot
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:', 'blob:', GHOST_URL, IMMICH_URL].filter(Boolean),
      connectSrc:  ["'self'", GHOST_URL, IMMICH_URL, 'https://api.anthropic.com'].filter(Boolean),
      fontSrc:        ["'self'", 'data:', 'https://fonts.gstatic.com'],
      workerSrc:      ["'self'", 'blob:'],
      scriptSrcAttr:  ["'unsafe-inline'"],
      // Disable upgrade-insecure-requests: app is designed for HTTP-only local/LAN deployment
      upgradeInsecureRequests: false,
    },
  },
  // Disable headers that produce browser warnings on plain-HTTP LAN deployments
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
}));
const allowedOrigins = [
  process.env.GHOST_URL,
  process.env.IMMICH_URL,
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (same-origin, curl, Portainer)
    if (!origin) return cb(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// â”€â”€â”€ Multer (memory storage for Ghost upload proxy) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/jpeg|jpg|png|gif|webp|svg|ico/i.test(path.extname(file.originalname))) {
      cb(null, true);
    } else {
      cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', `File type not allowed: ${file.mimetype}`));
    }
  },
});

const uploadXml = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /\.xml$/i.test(file.originalname));
  },
}).single('xmlFile');

const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const VIDEO_MIME = [
      'video/mp4', 'video/quicktime', 'video/webm',
      'video/ogg', 'video/x-m4v',
      'audio/mpeg', 'audio/wav', 'audio/ogg',
      'audio/mp4', 'audio/flac',
    ];
    if (VIDEO_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', `File type not allowed: ${file.mimetype}`));
  },
});

const fileAttachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ALLOWED_MIME = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/zip', 'application/x-rar-compressed',
      'application/x-7z-compressed',
      'text/csv', 'application/json', 'text/plain', 'text/markdown',
    ];
    if (ALLOWED_MIME.includes(file.mimetype)) cb(null, true);
    else cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', `File type not allowed: ${file.mimetype}`));
  },
});

// â”€â”€â”€ WordPress XML import â€” session store (1-hour TTL) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const wpSessions = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [token, s] of wpSessions) {
    if (now - s.createdAt > 60 * 60 * 1000) wpSessions.delete(token);
  }
}, 5 * 60 * 1000);

// â”€â”€â”€ Ghost JWT helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function makeGhostToken(apiKey) {
  const [id, secret] = apiKey.split(':');
  if (!id || !secret) throw new Error('Invalid API key format');
  return jwt.sign({}, Buffer.from(secret, 'hex'), {
    keyid: id, algorithm: 'HS256', expiresIn: '5m', audience: '/admin/',
  });
}

// Extract Ghost API key from Authorization: Bearer <key> header
function getApiKey(req) {
  return (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
}

// ── Filesystem listing cache ───────────────────────────────────────────────────────────
// Caches directory scan results per namespace ('images', 'media', 'files') for 60s.
const _fsCache = new Map();
const FS_CACHE_TTL_MS = 60 * 1000;

function getFsCache(ns) {
  const entry = _fsCache.get(ns);
  if (!entry) return null;
  if (Date.now() - entry.ts > FS_CACHE_TTL_MS) { _fsCache.delete(ns); return null; }
  return entry.data;
}
function setFsCache(ns, data) {
  _fsCache.set(ns, { data, ts: Date.now() });
}
function invalidateFsCache(ns) {
  _fsCache.delete(ns);
}

// ── Auth middleware ────────────────────────────────────────────────────────────────────
// Validates the Ghost API key from Authorization: Bearer <key>.
// Caches successful validations for 60s (P2) to avoid a Ghost round-trip on
// every request. On 401, clears the cache entry so a re-key takes effect
// immediately. Sets req.apiKey for downstream handlers.
const _authCache = new Map();
const AUTH_CACHE_TTL_MS = 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of _authCache) {
    if (now - entry.validatedAt > AUTH_CACHE_TTL_MS) _authCache.delete(key);
  }
}, AUTH_CACHE_TTL_MS);

async function requireGhostAuth(req, res, next) {
  const apiKey = getApiKey(req);
  if (!apiKey) return res.status(400).json({ error: 'Missing API key' });

  const cached = _authCache.get(apiKey);
  if (cached && Date.now() - cached.validatedAt < AUTH_CACHE_TTL_MS) {
    req.apiKey = apiKey;
    return next();
  }

  try {
    const r = await ghostRequest(apiKey, '/site/');
    if (r.status === 401) {
      _authCache.delete(apiKey);
      return res.status(401).json({ error: 'Unauthorized' });
    }
    _authCache.set(apiKey, { validatedAt: Date.now() });
    req.apiKey = apiKey;
    return next();
  } catch {
    return res.status(503).json({ error: 'Cannot reach Ghost' });
  }
}

// â”€â”€â”€ Ghost request helper (GHOST_URL always from server env) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// After creating a post/page via ?source=html, Ghost doesn't extract <video src> into the
// Lexical video card node. This helper fetches the Lexical JSON and back-fills empty video srcs.
// Extract a real JPEG thumbnail frame from a video buffer using ffmpeg.
// Returns { thumbBuf, width, height, duration } — same data Ghost's Canvas API provides.
async function extractVideoFrame(buffer, filename) {
  const tmpBase   = path.join(os.tmpdir(), `gm_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`);
  const tmpInput  = `${tmpBase}${path.extname(filename) || '.mp4'}`;
  const tmpOutput = `${tmpBase}_thumb.jpg`;
  try {
    fsSync.writeFileSync(tmpInput, buffer);

    const meta = await new Promise((resolve, reject) =>
      ffmpeg.ffprobe(tmpInput, (err, data) => err ? reject(err) : resolve(data))
    );
    const vs       = meta.streams.find(s => s.codec_type === 'video') || {};
    const width    = vs.width    || 1280;
    const height   = vs.height   || 720;
    const duration = parseFloat(meta.format?.duration || 0);
    const seekTime = duration > 1 ? 0.5 : (duration > 0 ? duration * 0.1 : 0);

    await new Promise((resolve, reject) =>
      ffmpeg(tmpInput)
        .seekInput(seekTime)
        .frames(1)
        .outputOptions(['-q:v', '3'])   // JPEG quality (2=best, lower=worse)
        .output(tmpOutput)
        .on('end', resolve)
        .on('error', reject)
        .run()
    );

    const thumbBuf = fsSync.readFileSync(tmpOutput);
    return { thumbBuf, width, height, duration };
  } catch (err) {
    console.warn('[extractVideoFrame] failed for', filename, err.message);
    // Fallback: 1×1 dark pixel in correct aspect ratio — better than wrong 16:9
    const thumbBuf = await sharp({
      create: { width: 1280, height: 720, channels: 3, background: { r: 20, g: 20, b: 20 } }
    }).jpeg({ quality: 60 }).toBuffer();
    return { thumbBuf, width: 1280, height: 720, duration: 0 };
  } finally {
    try { fsSync.unlinkSync(tmpInput);  } catch {}
    try { fsSync.unlinkSync(tmpOutput); } catch {}
  }
}

async function patchVideoNodes(apiKey, postId, isPage, newVideoUrls, thumbUrls = [], metaArr = []) {
  const kind = isPage ? 'pages' : 'posts';
  // Must include ?formats=lexical; otherwise Ghost omits the lexical field entirely
  const r = await ghostRequest(apiKey, `/${kind}/${postId}/?formats=lexical&fields=id,updated_at,lexical`);
  if (!r.ok) return;
  const data = await r.json();
  const record = (data[kind] || [])[0];
  if (!record?.lexical) { console.warn('[patchVideoNodes] no lexical field in response for', postId); return; }
  let lexical;
  try { lexical = JSON.parse(record.lexical); } catch { return; }

  let idx = 0;
  let patchCount = 0;
  function walk(node) {
    if (node.type === 'video' && idx < newVideoUrls.length) {
      const videoUrl = newVideoUrls[idx];
      const thumbUrl = thumbUrls[idx] || '';
      const meta     = metaArr[idx]  || {};
      // Always overwrite all metadata — Ghost HTML parser leaves width/height/mimeType/fileName null/empty
      // which causes the published page to render poster="spacergif.org/nullxnull" collapsing to zero height
      node.src          = videoUrl || node.src;
      node.thumbnailSrc = thumbUrl || node.thumbnailSrc;
      // Use real dimensions from ffprobe; fall back to existing or 1280×720
      node.width           = meta.width  || node.width  || 1280;
      node.height          = meta.height || node.height || 720;
      node.thumbnailWidth  = meta.width  || node.thumbnailWidth  || node.width  || 1280;
      node.thumbnailHeight = meta.height || node.thumbnailHeight || node.height || 720;
      node.duration        = meta.duration != null ? meta.duration : (node.duration || 0);
      node.loop = false;
      if (!node.mimeType) {
        const ext = (videoUrl || '').split('?')[0].split('.').pop().toLowerCase();
        node.mimeType = ext === 'mp4' ? 'video/mp4' : ext === 'mov' ? 'video/quicktime'
          : ext === 'webm' ? 'video/webm' : 'video/mp4';
      }
      if (!node.fileName) {
        node.fileName = (videoUrl || '').split('/').pop().split('?')[0];
      }
      patchCount++;
      idx++;
    }
    if (node.children) node.children.forEach(walk);
  }
  walk(lexical.root);
  if (patchCount === 0) return;

  await ghostRequest(apiKey, `/${kind}/${postId}/`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [kind]: [{ id: postId, updated_at: record.updated_at, lexical: JSON.stringify(lexical) }] }),
  });
}

// â”€â”€â”€ WordPress XML helper utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Extract string value from a field that may be a plain string or a {__cdata:...} object
function cdataStr(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val.__cdata !== undefined) return String(val.__cdata);
  return String(val);
}

function decodeHtmlEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#(\d+);/g,         (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g,   '&')
    .replace(/&lt;/g,    '<')
    .replace(/&gt;/g,    '>')
    .replace(/&quot;/g,  '"')
    .replace(/&apos;/g,  "'")
    .replace(/&nbsp;/g,  '\u00A0')
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&hellip;/g,'\u2026')
    .replace(/&laquo;/g, '\u00AB')
    .replace(/&raquo;/g, '\u00BB')
    .replace(/&ouml;/g,  '\u00F6')
    .replace(/&uuml;/g,  '\u00FC')
    .replace(/&auml;/g,  '\u00E4')
    .replace(/&Ouml;/g,  '\u00D6')
    .replace(/&Uuml;/g,  '\u00DC')
    .replace(/&Auml;/g,  '\u00C4')
    .replace(/&szlig;/g, '\u00DF');
}

function cleanExcerpt(raw) {
  if (!raw) return null;
  const text = raw
    .replace(/<!--\s*\/?(wp:[^\s>][^>]*)-->/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
  return decodeHtmlEntities(text) || null;
}

function wpDateToIso(wpDate) {
  if (!wpDate || wpDate === '0000-00-00 00:00:00') return null;
  try { return new Date(wpDate.replace(' ', 'T') + 'Z').toISOString(); } catch { return null; }
}

// Balanced <figure>...</figure> finder.
// Returns the end index (exclusive) of the <figure> that starts at startIdx.
function findFigureEnd(content, startIdx) {
  let depth = 0, i = startIdx;
  while (i < content.length) {
    const nextOpen  = content.indexOf('<figure', i);
    const nextClose = content.indexOf('</figure>', i);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      i = nextOpen + 7;
    } else {
      depth--;
      if (depth === 0) return nextClose + 9;
      i = nextClose + 9;
    }
  }
  return -1;
}

// â”€â”€ Gutenberg block converter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function convertGutenbergToHtml(rawContent) {
  if (!rawContent) return { html: '', coverUrl: null, mediaUrls: [] };

  const mediaUrls = [];
  let coverUrl = null;

  function processBlock(type, attrsJson, inner) {
    let attrs = {};
    if (attrsJson) { try { attrs = JSON.parse(attrsJson.trim()); } catch {} }

    switch (type) {
      case 'paragraph': {
        const clean = inner.replace(/<p[^>]*>/g, '<p>').trim();
        return /^<p>\s*<\/p>$/.test(clean) ? '' : clean;
      }
      case 'heading':
        return inner.replace(/<h([1-6])[^>]*>/g, '<h$1>').trim();
      case 'separator':
        return '<hr>';

      case 'image': {
        const imgM = inner.match(/<img[^>]+src="([^"]+)"[^>]*>/);
        if (!imgM) return '';
        const imgTag = imgM[0];
        // Priority: data-src (lazy-load real URL) > noscript img src > src (if not data: URI)
        const dataSrcM = imgTag.match(/data-src="([^"]+)"/);
        let srcFromHtml = dataSrcM && dataSrcM[1].startsWith('http') ? dataSrcM[1] : null;
        if (!srcFromHtml) {
          const noscriptM = inner.match(/<noscript>\s*<img[^>]+src="([^"]+)"[^>]*>\s*<\/noscript>/);
          if (noscriptM && noscriptM[1].startsWith('http')) srcFromHtml = noscriptM[1];
        }
        if (!srcFromHtml) {
          const rawSrc = imgM[1];
          if (!rawSrc.startsWith('data:')) srcFromHtml = rawSrc;
        }
        // Prefer the full-size URL from block attrs (attrs.url) over the possibly-resized <img src>
        const src = attrs.url || srcFromHtml;
        // Skip placeholder/unfinished WP uploads (no valid http src)
        if (!src || !src.startsWith('http')) return '';
        const altM = imgTag.match(/alt="([^"]*)"/);       
        const alt = altM ? altM[1] : '';
        mediaUrls.push(src);
        // Also queue the inner-HTML src if different (e.g. -scaled variant)
        if (attrs.url && srcFromHtml && srcFromHtml !== attrs.url) mediaUrls.push(srcFromHtml);
        return `<figure class="kg-image-card"><img class="kg-image" src="${src}" alt="${escapeHtml(alt)}"></figure>`;
      }

      case 'cover': {
        // Priority: JSON attrs.url â†’ inner <img src> â†’ null. NEVER background-image.
        if (!coverUrl) {
          if (attrs.url) {
            coverUrl = attrs.url;
          } else {
            const imgM = inner.match(/<img[^>]+src="([^"]+)"/);
            if (imgM) coverUrl = imgM[1];
          }
        }
        return ''; // No body output
      }

      case 'video': {
        const videoM = inner.match(/<video[^>]+src="([^"]+)"/);
        if (!videoM) return '';
        const src = videoM[1];
        mediaUrls.push(src);
        return `<figure class="kg-card kg-video-card"><div class="kg-video-container"><video src="${src}" controls playsinline></video></div></figure>`;
      }

      case 'gallery': {
        const images = [];

        // Old format: <!-- wp:image --> block markers inside gallery
        const blockImgRe = /<!-- wp:image(\s+(\{[\s\S]*?\}))?\s*(?:\/)?-->(\s*<figure[\s\S]*?<\/figure>\s*)(?:<!-- \/wp:image\s*-->)?/g;
        let m;
        while ((m = blockImgRe.exec(inner)) !== null) {
          const imgHtml = processBlock('image', m[2] || '', m[3] || '');
          if (imgHtml) {
            const innerImg = imgHtml.replace(/<figure[^>]*>|<\/figure>/g, '');
            images.push(`<figure class="kg-gallery-image">${innerImg}</figure>`);
          }
        }

        // New "nested-images" format: <figure class="wp-block-image"> directly in HTML
        // Images may be in <noscript> wrappers (lazy-load)
        if (!images.length) {
          const figRe = /<figure[^>]*class="[^"]*wp-block-image[^"]*"[^>]*>([\s\S]*?)<\/figure>/g;
          while ((m = figRe.exec(inner)) !== null) {
            const figInner = m[1];
            const mainImgTag = (figInner.match(/<img[^>]+>/) || [])[0];
            if (!mainImgTag) continue;
            // Priority: data-src (lazy-load real URL) > noscript img src > src (if not data: URI)
            const dataSrcM = mainImgTag.match(/data-src="([^"]+)"/);
            let src = dataSrcM && dataSrcM[1].startsWith('http') ? dataSrcM[1] : null;
            if (!src) {
              const noscriptM = figInner.match(/<noscript>\s*<img[^>]+src="([^"]+)"[^>]*>\s*<\/noscript>/);
              if (noscriptM && noscriptM[1].startsWith('http')) src = noscriptM[1];
            }
            if (!src) {
              const srcM = mainImgTag.match(/src="([^"]+)"/);
              if (srcM && !srcM[1].startsWith('data:')) src = srcM[1];
            }
            if (!src) continue;
            const altM = mainImgTag.match(/alt="([^"]*)"/);  // alt may be valueless attribute
            const alt = altM ? altM[1] : '';
            mediaUrls.push(src);
            images.push(`<figure class="kg-gallery-image"><img class="kg-image" src="${src}" alt="${escapeHtml(alt)}"></figure>`);
          }
        }

        if (!images.length) return '';
        return `<figure class="kg-gallery-card kg-width-wide"><div class="kg-gallery-container">${images.join('')}</div></figure>`;
      }

      case 'media-text': {
        let out = '';
        const imgM = inner.match(/<img[^>]+src="([^"]+)"[^>]*>/);
        if (imgM) {
          const imgTag = imgM[0];
          // Priority: data-src (lazy-load real URL) > noscript img src > src (if not data: URI)
          const dataSrcM = imgTag.match(/data-src="([^"]+)"/);
          let src = dataSrcM && dataSrcM[1].startsWith('http') ? dataSrcM[1] : null;
          if (!src) {
            const noscriptM = inner.match(/<noscript>\s*<img[^>]+src="([^"]+)"[^>]*>\s*<\/noscript>/);
            if (noscriptM && noscriptM[1].startsWith('http')) src = noscriptM[1];
          }
          if (!src) {
            if (!imgM[1].startsWith('data:')) src = imgM[1];
          }
          if (src) {
            const altM = imgTag.match(/alt="([^"]*)"/);
            const alt = altM ? altM[1] : '';
            mediaUrls.push(src);
            out += `<figure class="kg-image-card"><img class="kg-image" src="${src}" alt="${escapeHtml(alt)}"></figure>\n`;
          }
        }
        out += processContent(inner.replace(/<img[^>]+>/g, ''));
        return out;
      }

      case 'list':
        return inner
          .replace(/<!--\s*\/?(wp:list-item)[^>]*-->/g, '')
          .replace(/<(ul|ol|li)[^>]*>/g, '<$1>')
          .trim();

      case 'code':
        return inner.replace(/<pre[^>]*>/g, '<pre>').trim();

      case 'html':
        return inner.trim();

      case 'shortcode':
      case 'embed':
      case 'spacer':
      case 'columns':
      case 'column':
        return '';

      default:
        return inner.trim();
    }
  }

  function processContent(content) {
    if (!content) return '';
    const parts = [];
    let lastIndex = 0;

    // Matches self-closing: <!-- wp:TYPE ATTRS /--> and block pairs: <!-- wp:TYPE ATTRS -->INNER<!-- /wp:TYPE -->
    const blockRe =
      /<!-- wp:(\S+?)(\s+(\{[\s\S]*?\}))?\s*\/-->|<!-- wp:(\S+?)(\s+(\{[\s\S]*?\}))?\s*-->([\s\S]*?)<!-- \/wp:\4\s*-->/g;

    let m;
    while ((m = blockRe.exec(content)) !== null) {
      if (m.index > lastIndex) {
        const before = content.slice(lastIndex, m.index).trim();
        if (before) parts.push(before);
      }
      const result = m[1]
        ? processBlock(m[1], m[3] || '', '')          // self-closing
        : processBlock(m[4], m[6] || '', m[7] || ''); // block pair
      if (result) parts.push(result);
      lastIndex = m.index + m[0].length;
    }

    if (lastIndex < content.length) {
      const after = content.slice(lastIndex).trim();
      if (after) parts.push(after);
    }
    return parts.join('\n');
  }

  // Pre-process: convert standalone wp-block-gallery figures that have NO <!-- wp:gallery -->
  // block comment markers (e.g. the "has-nested-images" format). Without this step they fall
  // through processContent as raw HTML and the post-processing cleanup strips data-src +
  // <noscript> before any URLs are extracted, making all gallery images disappear.
  {
    // Mark ranges already covered by <!-- wp:gallery --> block comments (handled by case 'gallery')
    const coveredRanges = [];
    const galleryBlockRe = /<!-- wp:gallery(?:\s+\{[\s\S]*?\})?\s*-->/g;
    let gbm;
    while ((gbm = galleryBlockRe.exec(rawContent)) !== null) {
      const closeIdx = rawContent.indexOf('<!-- /wp:gallery', gbm.index + gbm[0].length);
      if (closeIdx !== -1) coveredRanges.push([gbm.index, closeIdx + 20]);
    }
    const isCovered = pos => coveredRanges.some(([s, e]) => pos >= s && pos < e);

    const standaloneRe = /<figure[^>]*class="[^"]*wp-block-gallery[^"]*"[^>]*>/g;
    let sgm;
    const replacements = [];
    while ((sgm = standaloneRe.exec(rawContent)) !== null) {
      if (isCovered(sgm.index)) continue;
      const startIdx = sgm.index;
      const endIdx   = findFigureEnd(rawContent, startIdx);
      if (endIdx === -1) continue;
      const galleryHtml = rawContent.slice(startIdx, endIdx);

      const kgImages = [];
      const childRe  = /<figure[^>]*class="[^"]*wp-block-image[^"]*"[^>]*>([\s\S]*?)<\/figure>/g;
      let cfm;
      while ((cfm = childRe.exec(galleryHtml)) !== null) {
        const figContent = cfm[1];
        const mainImg = (figContent.match(/<img[^>]+>/) || [])[0];
        if (!mainImg) continue;
        // Lazy-load priority: data-src → <noscript> src → src (if not data: URI)
        let src = null;
        const dsM = mainImg.match(/data-src="([^"]+)"/);
        if (dsM && dsM[1].startsWith('http')) src = dsM[1];
        if (!src) {
          const nsM = figContent.match(/<noscript>\s*<img[^>]+src="([^"]+)"[^>]*>\s*<\/noscript>/);
          if (nsM && nsM[1].startsWith('http')) src = nsM[1];
        }
        if (!src) {
          const sM = mainImg.match(/src="([^"]+)"/);
          if (sM && !sM[1].startsWith('data:')) src = sM[1];
        }
        if (!src) continue;
        const altM = mainImg.match(/alt="([^"]*)"/);
        const alt  = altM ? altM[1] : '';
        mediaUrls.push(src);
        kgImages.push(`<figure class="kg-gallery-image"><img class="kg-image" src="${src}" alt="${escapeHtml(alt)}"></figure>`);
      }
      if (kgImages.length) {
        replacements.push({
          start: startIdx, end: endIdx,
          html:  `<figure class="kg-gallery-card kg-width-wide"><div class="kg-gallery-container">${kgImages.join('')}</div></figure>`,
        });
      }
    }
    // Apply in reverse so earlier replacements don't shift indices of later ones
    for (let i = replacements.length - 1; i >= 0; i--) {
      const { start, end, html } = replacements[i];
      rawContent = rawContent.slice(0, start) + html + rawContent.slice(end);
    }
  }

  let html = processContent(rawContent);

  // Post-processing cleanup
  html = html
    .replace(/<!--\s*\/?(wp:[^\s>][^>]*)\s*-->/g, '')
    .replace(/\s+class="(?:wp-[^"]*|has-[^"]*)"/g, '')
    .replace(/\s+data-[a-z][a-z0-9-]*="[^"]*"/g, '')
    .replace(/\s+srcset="[^"]*"/g, '')
    .replace(/\s+sizes="[^"]*"/g, '')
    .replace(/\s+loading="[^"]*"/g, '')
    .replace(/\s+style="[^"]*"/g, '')
    .replace(/<noscript>[\s\S]*?<\/noscript>/g, '')
    .replace(/(<p>\s*<\/p>\s*){2,}/g, '')
    .replace(/(<hr>\s*){2,}/g, '<hr>')
    .trim();

  return { html, coverUrl, mediaUrls };
}

// Delete or rename all responsive size variants for a given relative image path.
// Ghost stores them at: <GHOST_MEDIA_PATH>/size/w<N>/<relPath>
async function handleSizeVariants(relPath, newRelPath = null) {
  const sizeDir = path.join(GHOST_MEDIA_PATH, 'size');
  let widthDirs;
  try { widthDirs = await fs.readdir(sizeDir); } catch { return; } // no size dir â€” fine

  await Promise.all(widthDirs.map(async (wDir) => {
    const variantPath = path.join(sizeDir, wDir, relPath);
    try {
      await fs.access(variantPath);
      if (newRelPath) {
        const newVariantPath = path.join(sizeDir, wDir, newRelPath);
        await fs.mkdir(path.dirname(newVariantPath), { recursive: true });
        await fs.rename(variantPath, newVariantPath);
      } else {
        await fs.unlink(variantPath);
      }
    } catch { /* variant doesn't exist for this width â€” skip */ }
  }));
}
// â”€â”€â”€ Routes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Serve frontend
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// â”€â”€ Config: tell the client which Ghost instance is configured â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/config', async (_req, res) => {
  let hasFs = false;
  let hasVideoFs = false;
  let hasFilesFs = false;
  try { const e = await fs.readdir(GHOST_MEDIA_PATH);       hasFs      = e.length > 0; } catch {}
  try { const e = await fs.readdir(GHOST_MEDIA_VIDEO_PATH); hasVideoFs = e.length > 0; } catch {}
  try { const e = await fs.readdir(GHOST_MEDIA_FILES_PATH); hasFilesFs = e.length > 0; } catch {}
  res.json({ ghostUrl: GHOST_URL, hasFs, hasVideoFs, hasFilesFs, aiAvailable: !!ANTHROPIC_API_KEY });
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: require('./package.json').version });
});

app.get('/api/ghost/lang', requireGhostAuth, async (req, res) => {
  try {
    const lang = await getGhostLang(req.apiKey);
    res.json({ lang });
  } catch {
    res.json({ lang: 'en' });
  }
});

// â”€â”€ Auth: validate API key â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/auth/validate', async (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey) return res.status(400).json({ error: 'Missing apiKey' });
  try {
    const r = await ghostRequest(apiKey, '/site/');
    if (r.ok) {
      const data = await r.json();
      return res.json({ success: true, site: data.site });
    }
    return res.status(401).json({ error: 'Invalid API Key' });
  } catch (e) {
    return res.status(500).json({ error: 'Connection failed. Check server GHOST_URL.' });
  }
});

// â”€â”€ Media: list images â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ghost has no image-listing API endpoint â€“ we scan the filesystem mount.
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.ico', '.avif']);

app.get('/api/media', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;

  const cached = getFsCache('images');
  if (cached) return res.json(cached);

  // List from filesystem — gracefully return empty list if path not accessible
  let fsMounted = false;
  try { await fs.access(GHOST_MEDIA_PATH); fsMounted = true; } catch {}

  if (!fsMounted) {
    return res.json({ images: [], fsMounted: false, meta: { pagination: { total: 0, pages: 1 } } });
  }

  try {
    const images = await walkContentDir(GHOST_MEDIA_PATH, `${GHOST_URL}/content/images`, {
      skipDirs: ['size'],
      extFilter: IMAGE_EXTS,
      skipFile: (entry) => entry.name.replace(/\.[^.]+$/, '').endsWith('_o'),
      buildEntry: async (entry, rel, stat) => ({
        id:         rel,
        url:        `${GHOST_URL}/content/images/${rel}`,
        filename:   entry.name,
        size:       stat.size,
        created_at: stat.mtime.toISOString(),
        width:      null,
        height:     null,
      }),
    });
    // Sort newest first by mtime
    images.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const payload = { images, fsMounted: true, meta: { pagination: { total: images.length, pages: 1 } } };
    setFsCache('images', payload);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to read media directory' });
  }
})

// â”€â”€ Media: upload image(s) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/media/upload', requireGhostAuth, upload.array('files', 20), async (req, res) => {
  const apiKey = req.apiKey;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const results = [];
  for (const file of req.files) {
    try {
      const r    = await uploadImage(apiKey, file.buffer, file.originalname, file.mimetype);
      const data = await r.json();
      if (r.ok) results.push({ success: true,  file: file.originalname, image: data.images?.[0] });
      else      results.push({ success: false, file: file.originalname, error: data.errors?.[0]?.message || 'Upload failed' });
    } catch {
      results.push({ success: false, file: file.originalname, error: 'Upload error' });
    }
  }
  invalidateFsCache('images');
  return res.json({ results });
});

// ── Videos: upload video/audio file(s) ────────────────────────────────────────
app.post('/api/videos/upload', requireGhostAuth, videoUpload.array('files', 10), async (req, res) => {
  const apiKey = req.apiKey;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const results = [];
  for (const file of req.files) {
    try {
      const r    = await uploadMedia(apiKey, file.buffer, file.originalname, file.mimetype);
      const data = await r.json();
      if (r.ok) {
        const ghost = data.media?.[0] || {};
        results.push({ success: true, file: file.originalname, media: { ...ghost, name: ghost.ref || file.originalname, size: file.size, mtime: Date.now(), thumbUrl: null } });
      } else {
        results.push({ success: false, file: file.originalname, error: data.errors?.[0]?.message || 'Upload failed' });
      }
    } catch {
      results.push({ success: false, file: file.originalname, error: 'Upload error' });
    }
  }
  invalidateFsCache('videos');
  return res.json({ results });
});

// ── Files: upload file attachment(s) ──────────────────────────────────────────
app.post('/api/files/upload', requireGhostAuth, fileAttachmentUpload.array('files', 10), async (req, res) => {
  const apiKey = req.apiKey;
  if (!req.files || req.files.length === 0) return res.status(400).json({ error: 'No files uploaded' });

  const results = [];
  for (const file of req.files) {
    try {
      const r    = await uploadFile(apiKey, file.buffer, file.originalname, file.mimetype);
      const data = await r.json();
      if (r.ok) {
        const ghost = data.files?.[0] || {};
        const name  = ghost.ref || file.originalname;
        results.push({ success: true, file: file.originalname, attachment: { ...ghost, name, ext: name.split('.').pop().toLowerCase(), size: file.size, mtime: Date.now() } });
      } else {
        results.push({ success: false, file: file.originalname, error: data.errors?.[0]?.message || 'Upload failed' });
      }
    } catch {
      results.push({ success: false, file: file.originalname, error: 'Upload error' });
    }
  }
  invalidateFsCache('files');
  return res.json({ results });
});

// â”€â”€ Media: proxy image through server (avoids canvas CORS for editor) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/media/proxy', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).end();
  // Only proxy images from the configured Ghost instance (prevent SSRF)
  if (!url.startsWith(`${GHOST_URL}/content/images/`)) return res.status(403).end();
  try {
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).end();
    const buf = await r.buffer();
    res.set('Content-Type', r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(buf);
  } catch { return res.status(500).end(); }
});

// â”€â”€ Media: overwrite existing image file with edited version â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/media/overwrite', requireGhostAuth, upload.single('file'), async (req, res) => {
  const apiKey = req.apiKey;
  const { imageUrl } = req.query;
  if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  let absPath, relPath;
  try { ({ absPath, relPath } = urlToContentPath(imageUrl, 'images')); }
  catch { return res.status(400).json({ error: 'Cannot resolve file path from URL' }); }

  const tmpPath = absPath + '.tmp';
  try {
    await fs.writeFile(tmpPath, req.file.buffer);
    await fs.rename(tmpPath, absPath); // atomic on same filesystem
    await handleSizeVariants(relPath);
    // Delete the _o original — it's now stale after editing
    const ext      = path.extname(absPath);
    const origPath = `${absPath.slice(0, -ext.length)}_o${ext}`;
    await fs.unlink(origPath).catch(() => {});
    invalidateFsCache('images');
    return res.json({ success: true });
  } catch (e) {
    try { await fs.unlink(absPath + '.tmp'); } catch {}
    return res.status(500).json({ error: `Overwrite failed: ${e.message}` });
  }
});

// â”€â”€ Media: delete image â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Primary: physical delete from mounted filesystem + size variants.
// Ghost has no reliable image-listing API so DB IDs aren't available;
// the file deletion from disk is what actually removes the image.
app.delete('/api/media/file', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  const { imageUrl } = req.query;
  if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl' });

  let absPath, relPath;
  try { ({ absPath, relPath } = urlToContentPath(imageUrl, 'images')); }
  catch { return res.status(400).json({ error: 'Cannot resolve file path from URL' }); }

  try { await fs.access(absPath); }
  catch { return res.status(404).json({ error: 'File not found on mounted filesystem' }); }

  try {
    await fs.unlink(absPath);
    await handleSizeVariants(relPath);
    // Also delete Ghost's _o original (e.g. IMG_0401_o.JPG alongside IMG_0401.JPG)
    const ext      = path.extname(absPath);
    const origPath = `${absPath.slice(0, -ext.length)}_o${ext}`;
    await fs.unlink(origPath).catch(() => {}); // ignore if doesn't exist
    invalidateFsCache('images');
    return res.json({ success: true, fsDeleted: true });
  } catch (e) {
    return res.status(500).json({ error: `Delete failed: ${e.message}` });
  }
});

// â”€â”€ Media: physical file rename (requires filesystem mount) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/media/insert-into-post',
  requireGhostAuth,
  insertImageLimiter,
  async (req, res) => {
    try {
      const apiKey = req.apiKey;
      const {
        mode     = 'image',
        postId,
        postType = 'posts',
        position = 'end',
        caption  = '',
      } = req.body;

      if (!postId) return res.status(400).json({ error: 'Missing postId' });

      const type         = postType === 'pages' ? 'pages' : 'posts';
      const GHOST_URL_VAL = (process.env.GHOST_URL || '').replace(/\/$/, '');

      const post = await getPost(apiKey, type, postId);
      if (!post)         return res.status(404).json({ error: 'Post not found' });
      if (!post.lexical) return res.status(400).json({ error: 'Post has no Lexical content' });

      let newLexical;

      if (mode === 'gallery') {
        const { imageUrls } = req.body;

        if (!Array.isArray(imageUrls) || imageUrls.length < 2)
          return res.status(400).json({ error: 'imageUrls must be an array of at least 2 URLs' });
        if (imageUrls.length > 9)
          return res.status(400).json({ error: 'Gallery supports a maximum of 9 images' });

        for (const u of imageUrls) {
          if (!u.startsWith('/content/images/') &&
              !(GHOST_URL_VAL && u.startsWith(`${GHOST_URL_VAL}/content/images/`)))
            return res.status(400).json({ error: `Invalid imageUrl in gallery: ${u}` });
        }

        const validGalleryPositions = ['end', 'beginning'];
        if (!validGalleryPositions.includes(position))
          return res.status(400).json({ error: 'position for galleries must be "end" or "beginning"' });

        // Read dimensions for all images in parallel (best-effort, non-fatal)
        const images = await Promise.all(imageUrls.map(async (src) => {
          let width = null, height = null;
          try {
            const { absPath } = urlToContentPath(src, 'images');
            const meta = await sharp(absPath).metadata();
            width  = meta.width  || null;
            height = meta.height || null;
          } catch { /* non-fatal */ }
          return { src, width, height };
        }));

        const galleryNode = buildGalleryNode(images, caption);
        newLexical = insertGalleryNode(post.lexical, galleryNode, position);

      } else {
        // mode === 'image' (default)
        const { imageUrl, alt = '', cardWidth = 'regular' } = req.body;

        if (!imageUrl) return res.status(400).json({ error: 'Missing imageUrl' });

        const isRelative = imageUrl.startsWith('/content/images/');
        const isAbsolute = GHOST_URL_VAL && imageUrl.startsWith(`${GHOST_URL_VAL}/content/images/`);
        if (!isRelative && !isAbsolute)
          return res.status(400).json({ error: 'imageUrl must be a Ghost-hosted /content/images/ path' });

        const validWidths    = ['regular', 'wide', 'full'];
        const validPositions = ['end', 'beginning', 'after-first-image'];
        if (!validWidths.includes(cardWidth))
          return res.status(400).json({ error: `Invalid cardWidth: ${cardWidth}` });
        if (!validPositions.includes(position))
          return res.status(400).json({ error: `Invalid position: ${position}` });

        // Optionally read image dimensions — improves Ghost srcset; silently skipped on failure
        let width = null, height = null;
        try {
          const { absPath } = urlToContentPath(imageUrl, 'images');
          const meta = await sharp(absPath).metadata();
          width  = meta.width  || null;
          height = meta.height || null;
        } catch { /* non-fatal */ }

        const imageNode = buildImageNode(imageUrl, { alt, caption, cardWidth, width, height });
        newLexical = insertImageNode(post.lexical, imageNode, position);
      }

      const updateRes = await updatePost(apiKey, type, postId, {
        lexical:    newLexical,
        updated_at: post.updated_at,
      });

      if (!updateRes.ok) {
        const err = await updateRes.json().catch(() => ({}));
        return res.status(500).json({ error: err.errors?.[0]?.message || 'Post update failed' });
      }

      return res.json({ success: true });
    } catch (e) {
      logError('insert-into-post', e);
      return res.status(500).json({ error: e.message || 'Internal server error' });
    }
  }
);

app.post('/api/media/rename', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  const { imageUrl, newFilename } = req.body;
  if (!imageUrl || !newFilename) return res.status(400).json({ error: 'Missing imageUrl or newFilename' });
  // Block path separators and traversal in the new filename
  if (/[\/\\]/.test(newFilename) || newFilename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  let oldAbsPath, oldRelPath;
  try { ({ absPath: oldAbsPath, relPath: oldRelPath } = urlToContentPath(imageUrl, 'images')); }
  catch { return res.status(400).json({ error: 'Cannot resolve image path from URL' }); }

  const dir         = path.dirname(oldAbsPath);
  const newFilePath = path.join(dir, newFilename);

  // Confirm new path stays inside GHOST_MEDIA_PATH (prevent traversal)
  try { resolveContentPath(`/content/images/${path.dirname(oldRelPath)}/${newFilename}`, '/content/images/', GHOST_MEDIA_PATH); }
  catch { return res.status(400).json({ error: 'Invalid filename' }); }

  try { await fs.access(oldAbsPath); }
  catch { return res.status(404).json({ error: 'File not found on mounted filesystem' }); }

  try {
    await fs.rename(oldAbsPath, newFilePath);
    const origUrl = new URL(imageUrl);
    const newUrl  = `${origUrl.origin}${origUrl.pathname.replace(/[^/]+$/, newFilename)}`;
    // Rename responsive size variants too
    const newRel = path.join(path.dirname(oldRelPath), newFilename).replace(/\\/g, '/');
    await handleSizeVariants(oldRelPath, newRel);
    // Rename Ghost's _o original alongside the main file
    const ext         = path.extname(oldAbsPath);
    const oldOrigPath = `${oldAbsPath.slice(0, -ext.length)}_o${ext}`;
    const newExt      = path.extname(newFilePath);
    const newOrigPath = `${newFilePath.slice(0, -newExt.length)}_o${newExt}`;
    await fs.rename(oldOrigPath, newOrigPath).catch(() => {}); // ignore if doesn't exist
    invalidateFsCache('images');
    return res.json({ success: true, newUrl });
  } catch (e) {
    return res.status(500).json({ error: `Rename failed: ${e.message}` });
  }
});

// ── Videos ──────────────────────────────────────────────────────────────────────
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v']);

// GET /api/videos — list all videos from content/media
app.get('/api/videos', requireGhostAuth, async (req, res) => {
  const cached = getFsCache('media');
  if (cached) return res.json(cached);

  let fsMounted = false;
  try { await fs.access(GHOST_MEDIA_VIDEO_PATH); fsMounted = true; } catch {}
  if (!fsMounted) {
    return res.json({ videos: [], fsMounted: false });
  }

  try {
    const videos = await walkContentDir(GHOST_MEDIA_VIDEO_PATH, `${GHOST_URL}/content/media`, {
      extFilter: VIDEO_EXTS,
      buildEntry: async (entry, rel, stat, dir) => {
        const baseName  = entry.name.replace(/\.[^.]+$/, '');
        const thumbPath = path.join(dir, baseName + '_thumb.jpg');
        let hasThumbnail = false;
        try { await fs.access(thumbPath); hasThumbnail = true; } catch {}
        return {
          id:       rel,
          url:      `${GHOST_URL}/content/media/${rel}`,
          name:     entry.name,
          size:     stat.size,
          mtime:    stat.mtime.getTime(),
          thumbUrl: hasThumbnail ? `${GHOST_URL}/content/media/${baseName}_thumb.jpg` : null,
        };
      },
    });
    videos.sort((a, b) => b.mtime - a.mtime);
    const payload = { videos, fsMounted: true };
    setFsCache('media', payload);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to read video directory' });
  }
});

// GET /api/videos/thumbnail — serve existing _thumb.jpg from disk
app.get('/api/videos/thumbnail', async (req, res) => {
  const { videoUrl } = req.query;
  if (!videoUrl) return res.status(400).end();

  let absPath;
  try { ({ absPath } = urlToContentPath(videoUrl, 'media')); }
  catch { return res.status(400).end(); }

  const ext       = path.extname(absPath);
  const thumbPath = absPath.slice(0, -ext.length) + '_thumb.jpg';

  try {
    await fs.access(thumbPath);
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    const data = await fs.readFile(thumbPath);
    return res.send(data);
  } catch {
    return res.status(404).end();
  }
});

// DELETE /api/videos/file — delete video + companion _thumb.jpg from disk
app.delete('/api/videos/file', requireGhostAuth, async (req, res) => {
  const { videoUrl } = req.query;
  if (!videoUrl) return res.status(400).json({ error: 'Missing videoUrl' });

  let absPath;
  try { ({ absPath } = urlToContentPath(videoUrl, 'media')); }
  catch { return res.status(400).json({ error: 'Invalid videoUrl' }); }

  try { await fs.access(absPath); }
  catch { return res.status(404).json({ error: 'File not found' }); }

  try {
    await fs.unlink(absPath);
    const ext       = path.extname(absPath);
    const thumbPath = absPath.slice(0, -ext.length) + '_thumb.jpg';
    await fs.unlink(thumbPath).catch(() => {});
    invalidateFsCache('media');
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: `Delete failed: ${e.message}` });
  }
});

// POST /api/videos/rename — rename video file + thumbnail, update all posts
app.post('/api/videos/rename', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  const { videoUrl, newFilename } = req.body;
  if (!videoUrl || !newFilename) {
    return res.status(400).json({ error: 'Missing videoUrl or newFilename' });
  }
  if (/[\/]/.test(newFilename) || newFilename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  if (!VIDEO_EXTS.has(path.extname(newFilename).toLowerCase())) {
    return res.status(400).json({ error: 'New filename must keep a valid video extension' });
  }

  let oldAbsPath, oldRelPath;
  try { ({ absPath: oldAbsPath, relPath: oldRelPath } = urlToContentPath(videoUrl, 'media')); }
  catch { return res.status(400).json({ error: 'Invalid videoUrl' }); }

  const dir         = path.dirname(oldAbsPath);
  const newFilePath = path.join(dir, newFilename);

  // Confirm new path stays inside GHOST_MEDIA_VIDEO_PATH
  try { resolveContentPath(`/content/media/${path.dirname(oldRelPath)}/${newFilename}`, '/content/media/', GHOST_MEDIA_VIDEO_PATH); }
  catch { return res.status(400).json({ error: 'Invalid filename' }); }

  try { await fs.access(oldAbsPath); }
  catch { return res.status(404).json({ error: 'File not found' }); }

  let origUrl;
  try { origUrl = new URL(videoUrl); }
  catch { return res.status(400).json({ error: 'Invalid videoUrl (could not parse)' }); }
  const dirPath = origUrl.pathname.replace(/[^/]+$/, '');
  const newUrl  = `${origUrl.origin}${dirPath}${newFilename}`;

  try {
    await fs.rename(oldAbsPath, newFilePath);
  } catch (e) {
    return res.status(500).json({ error: `File rename failed: ${e.message}` });
  }

  // Rename companion thumbnail
  const ext      = path.extname(oldAbsPath);
  const newExt   = path.extname(newFilePath);
  const oldThumb = oldAbsPath.slice(0, -ext.length) + '_thumb.jpg';
  const newThumb = newFilePath.slice(0, -newExt.length) + '_thumb.jpg';
  await fs.rename(oldThumb, newThumb).catch(() => {});

  // Update all posts that reference the old video URL
  const updated = await updateVideoUrlInPosts(apiKey, videoUrl, newUrl);

  invalidateFsCache('media');
  return res.json({ success: true, newUrl, postsUpdated: updated.count, postsFailed: updated.failed });
});

// Helper: scan all posts/pages and replace oldUrl with newUrl in Lexical JSON + image fields
async function updateVideoUrlInPosts(apiKey, oldUrl, newUrl) {
  let count = 0, failed = 0;
  try {
    const FIELDS = 'id,updated_at,feature_image,og_image,twitter_image';
    const [posts, pages] = await Promise.all([
      ghostFetchAll(apiKey, 'posts', FIELDS, { formats: 'lexical' }),
      ghostFetchAll(apiKey, 'pages', FIELDS, { formats: 'lexical' }),
    ]);
    posts.forEach(p => { p._type = 'posts'; });
    pages.forEach(p => { p._type = 'pages'; });
    const all = [...posts, ...pages];

    for (const post of all) {
      const fields = [post.lexical, post.feature_image, post.og_image, post.twitter_image];
      if (!fields.some(f => f && f.includes(oldUrl))) continue;

      const update = { id: post.id, updated_at: post.updated_at };

      if (post.lexical && post.lexical.includes(oldUrl)) {
        try {
          const doc = JSON.parse(post.lexical);
          const walk = (node) => {
            if (Array.isArray(node)) { node.forEach(walk); return; }
            if (!node || typeof node !== 'object') return;
            for (const key of Object.keys(node)) {
              if (typeof node[key] === 'string' && node[key] === oldUrl) {
                node[key] = newUrl;
              } else {
                walk(node[key]);
              }
            }
          };
          walk(doc);
          update.lexical = JSON.stringify(doc);
        } catch { /* skip corrupt lexical */ }
      }

      if (post.feature_image && post.feature_image.includes(oldUrl))
        update.feature_image = post.feature_image.split(oldUrl).join(newUrl);
      if (post.og_image && post.og_image.includes(oldUrl))
        update.og_image = post.og_image.split(oldUrl).join(newUrl);
      if (post.twitter_image && post.twitter_image.includes(oldUrl))
        update.twitter_image = post.twitter_image.split(oldUrl).join(newUrl);

      const type = post._type;
      try {
        const r = await ghostRequest(apiKey, `/${type}/${post.id}/`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [type]: [update] }),
        });
        if (r.ok) count++;
        else      failed++;
      } catch { failed++; }
    }
  } catch { /* ignore scan failures */ }

  return { count, failed };
}

// ── Files: walk content/files directory ───────────────────────────────────────

// GET /api/files — list all files from content/files
app.get('/api/files', requireGhostAuth, async (req, res) => {
  const cached = getFsCache('files');
  if (cached) return res.json(cached);

  let fsMounted = false;
  try { await fs.access(GHOST_MEDIA_FILES_PATH); fsMounted = true; } catch {}
  if (!fsMounted) {
    return res.json({ files: [], fsMounted: false });
  }

  try {
    const files = await walkContentDir(GHOST_MEDIA_FILES_PATH, `${GHOST_URL}/content/files`, {
      buildEntry: async (entry, rel, stat) => ({
        id:    rel,
        url:   `${GHOST_URL}/content/files/${rel}`,
        name:  entry.name,
        ext:   path.extname(entry.name).toLowerCase().slice(1),
        size:  stat.size,
        mtime: stat.mtime.getTime(),
      }),
    });
    files.sort((a, b) => b.mtime - a.mtime);
    const payload = { files, fsMounted: true };
    setFsCache('files', payload);
    return res.json(payload);
  } catch (e) {
    return res.status(500).json({ error: 'Failed to read files directory' });
  }
});

// GET /api/files/download — serve file with Content-Disposition attachment header
app.get('/api/files/download', requireGhostAuth, async (req, res) => {
  const { fileUrl } = req.query;
  if (!fileUrl) return res.status(400).end();

  let absPath;
  try { ({ absPath } = urlToContentPath(fileUrl, 'files')); }
  catch { return res.status(400).end(); }

  try {
    await fs.access(absPath);
    const filename = path.basename(absPath);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.set('Cache-Control', 'private, no-cache');
    const data = await fs.readFile(absPath);
    return res.send(data);
  } catch {
    return res.status(404).end();
  }
});

// DELETE /api/files/file — delete a file from content/files
app.delete('/api/files/file', requireGhostAuth, async (req, res) => {
  const { fileUrl } = req.query;
  if (!fileUrl) return res.status(400).json({ error: 'Missing fileUrl' });

  let absPath;
  try { ({ absPath } = urlToContentPath(fileUrl, 'files')); }
  catch { return res.status(400).json({ error: 'Invalid fileUrl' }); }

  try { await fs.access(absPath); }
  catch { return res.status(404).json({ error: 'File not found' }); }

  try {
    await fs.unlink(absPath);
    invalidateFsCache('files');
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: `Delete failed: ${e.message}` });
  }
});

// POST /api/files/rename — rename a file in content/files
app.post('/api/files/rename', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  const { fileUrl, newFilename } = req.body;
  if (!fileUrl || !newFilename) {
    return res.status(400).json({ error: 'Missing fileUrl or newFilename' });
  }
  if (/[\/]/.test(newFilename) || newFilename.includes('..')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  let oldAbsPath, oldRelPath;
  try { ({ absPath: oldAbsPath, relPath: oldRelPath } = urlToContentPath(fileUrl, 'files')); }
  catch { return res.status(400).json({ error: 'Invalid fileUrl' }); }

  const dir         = path.dirname(oldAbsPath);
  const newFilePath = path.join(dir, newFilename);

  // Confirm new path stays inside GHOST_MEDIA_FILES_PATH
  try { resolveContentPath(`/content/files/${path.dirname(oldRelPath)}/${newFilename}`, '/content/files/', GHOST_MEDIA_FILES_PATH); }
  catch { return res.status(400).json({ error: 'Invalid filename' }); }

  try { await fs.access(oldAbsPath); }
  catch { return res.status(404).json({ error: 'File not found' }); }

  let origUrl;
  try { origUrl = new URL(fileUrl); }
  catch { return res.status(400).json({ error: 'Invalid fileUrl (could not parse)' }); }
  const dirPath = origUrl.pathname.replace(/[^/]+$/, '');
  const newUrl  = `${origUrl.origin}${dirPath}${newFilename}`;

  try {
    await fs.rename(oldAbsPath, newFilePath);
    invalidateFsCache('files');
    return res.json({ success: true, newUrl });
  } catch (e) {
    return res.status(500).json({ error: `Rename failed: ${e.message}` });
  }
});


// â”€â”€ Posts: list (lightweight, for Posts tab) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/posts', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  const FIELDS = 'id,title,slug,url,status,excerpt,custom_excerpt,feature_image,updated_at,published_at';
  try {
    const [posts, pages] = await Promise.all([
      ghostFetchAll(apiKey, 'posts', FIELDS, { include: 'tags' }),
      ghostFetchAll(apiKey, 'pages', FIELDS, { include: 'tags' }),
    ]);
    posts.forEach(p => { p._type = 'post'; });
    pages.forEach(p => { p._type = 'page'; });
    return res.json({ posts, pages });
  } catch {
    return res.status(500).json({ error: 'Network error' });
  }
});

// â”€â”€ Posts: single post/page (full content, for improve dialog) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/posts/:type/:id', requireGhostAuth, async (req, res) => {
  const apiKey       = req.apiKey;
  const { type, id } = req.params;
  if (!['posts', 'pages'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

  const FIELDS = 'id,title,slug,url,status,excerpt,custom_excerpt,feature_image,lexical,html,meta_title,meta_description,updated_at,published_at';
  try {
    const r = await ghostRequest(apiKey, `/${type}/${id}/?fields=${FIELDS}&include=tags`);
    if (!r.ok) return res.status(r.status).json({ error: `Ghost error ${r.status}` });
    const data = await r.json();
    const item = (data[type] || [])[0] || null;
    if (!item) return res.status(404).json({ error: 'Not found' });
    item._type = type === 'pages' ? 'page' : 'post';
    return res.json(item);
  } catch {
    return res.status(500).json({ error: 'Network error' });
  }
});

// â”€â”€ Posts: fetch ALL (deep pagination, for usage scan) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/posts/all', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  const FIELDS = 'id,title,url,feature_image,og_image,twitter_image,updated_at';
  try {
    const [posts, pages] = await Promise.all([
      ghostFetchAll(apiKey, 'posts', FIELDS, { formats: 'html,lexical' }),
      ghostFetchAll(apiKey, 'pages', FIELDS, { formats: 'html,lexical' }),
    ]);
    posts.forEach(p => { p._type = 'post'; });
    pages.forEach(p => { p._type = 'page'; });
    return res.json({ posts, pages });
  } catch {
    return res.status(500).json({ error: 'Network error' });
  }
});

// â”€â”€ Posts: update a single post/page â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.put('/api/posts/:type/:id', requireGhostAuth, async (req, res) => {
  const apiKey       = req.apiKey;
  const { type, id } = req.params;
  const payload      = req.body;

  if (!['posts', 'pages'].includes(type)) return res.status(400).json({ error: 'Invalid type' });

  try {
    const r = await ghostRequest(apiKey, `/${type}/${id}/`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (r.status === 401) return res.status(401).json({ error: 'Unauthorized' });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.errors?.[0]?.message || 'Update failed' });
    return res.json(data);
  } catch {
    return res.status(500).json({ error: 'Network error' });
  }
});

// â”€â”€ Tags: fetch ALL (for usage scan) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/tags/all', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  const FIELDS = 'id,name,slug,url,feature_image,og_image,twitter_image,updated_at';
  try {
    const tags = await ghostFetchAll(apiKey, 'tags', FIELDS);
    tags.forEach(t => { t.type = 'tag'; });
    return res.json({ tags });
  } catch {
    return res.status(500).json({ error: 'Network error' });
  }
});

// â”€â”€ Tags: update a single tag â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.put('/api/tags/:id', requireGhostAuth, async (req, res) => {
  const apiKey  = req.apiKey;
  const { id }  = req.params;
  const payload = req.body;
  try {
    const r = await ghostRequest(apiKey, `/tags/${id}/`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (r.status === 401) return res.status(401).json({ error: 'Unauthorized' });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.errors?.[0]?.message || 'Update failed' });
    return res.json(data);
  } catch {
    return res.status(500).json({ error: 'Network error' });
  }
});

// â”€â”€ Users: fetch ALL (for usage scan) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/users/all', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  try {
    const r = await ghostRequest(apiKey, '/users/?limit=all&fields=id,name,slug,url,profile_image,cover_image,updated_at');
    if (!r.ok) return res.status(r.status).json({ error: 'Failed to fetch users' });
    const data = await r.json();
    const users = (data.users || []).map(u => ({ ...u, type: 'user' }));
    return res.json({ users });
  } catch {
    return res.status(500).json({ error: 'Network error' });
  }
});

// â”€â”€ Users: update a single user â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.put('/api/users/:id', requireGhostAuth, async (req, res) => {
  const apiKey  = req.apiKey;
  const { id }  = req.params;
  const payload = req.body;
  try {
    const r = await ghostRequest(apiKey, `/users/${id}/`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
    if (r.status === 401) return res.status(401).json({ error: 'Unauthorized' });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.errors?.[0]?.message || 'Update failed' });
    return res.json(data);
  } catch {
    return res.status(500).json({ error: 'Network error' });
  }
});

// â”€â”€ Immich: list albums â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/immich/albums', async (req, res) => {
  const { immichUrl, immichKey } = req.query;
  if (!immichUrl || !immichKey) return res.status(400).json({ error: 'Missing Immich params' });
  try {
    const r = await fetch(`${immichUrl.replace(/\/$/, '')}/api/albums`, {
      headers: { 'x-api-key': immichKey, Accept: 'application/json' },
    });
    if (r.status === 401) return res.status(401).json({ error: 'Invalid Immich API key' });
    if (!r.ok)            return res.status(r.status).json({ error: 'Immich request failed' });
    return res.json(await r.json());
  } catch {
    return res.status(500).json({ error: 'Cannot reach Immich server' });
  }
});

// â”€â”€ Immich: album assets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/immich/albums/:albumId', async (req, res) => {
  const { immichUrl, immichKey } = req.query;
  const { albumId } = req.params;
  if (!immichUrl || !immichKey) return res.status(400).json({ error: 'Missing Immich params' });
  try {
    const r = await fetch(`${immichUrl.replace(/\/$/, '')}/api/albums/${albumId}`, {
      headers: { 'x-api-key': immichKey, Accept: 'application/json' },
    });
    if (!r.ok) return res.status(r.status).json({ error: 'Immich request failed' });
    return res.json(await r.json());
  } catch {
    return res.status(500).json({ error: 'Network error' });
  }
});

// â”€â”€ Immich: thumbnail proxy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/immich/thumbnail/:assetId', async (req, res) => {
  const { immichUrl, immichKey } = req.query;
  const { assetId } = req.params;
  if (!immichUrl || !immichKey) return res.status(400).json({ error: 'Missing Immich params' });
  try {
    const r = await fetch(
      `${immichUrl.replace(/\/$/, '')}/api/assets/${assetId}/thumbnail?size=preview`,
      { headers: { 'x-api-key': immichKey } }
    );
    if (!r.ok) return res.status(r.status).end();
    res.set('Content-Type',  r.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    r.body.pipe(res);
  } catch {
    res.status(500).end();
  }
});

// â”€â”€ Immich â†’ Ghost: download original + re-upload â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/immich/use-in-ghost', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  const { immichUrl, immichKey, assetId, filename } = req.body;
  if (!immichUrl || !immichKey || !assetId) {
    return res.status(400).json({ error: 'Missing required params' });
  }
  try {
    const dlRes = await fetch(
      `${immichUrl.replace(/\/$/, '')}/api/assets/${assetId}/original`,
      { headers: { 'x-api-key': immichKey } }
    );
    if (!dlRes.ok) return res.status(500).json({ error: 'Failed to download from Immich' });

    const contentType  = dlRes.headers.get('content-type') || 'image/jpeg';
    const buffer       = await dlRes.buffer();
    const safeFilename = filename || `immich-${assetId}.jpg`;

    const uploadRes  = await uploadImage(apiKey, buffer, safeFilename, contentType);
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) return res.status(500).json({ error: uploadData.errors?.[0]?.message || 'Ghost upload failed' });
    return res.json({ success: true, image: uploadData.images?.[0] });
  } catch {
    return res.status(500).json({ error: 'Transfer failed' });
  }
});

// ── Immich → Ghost: download original + re-upload as media ──────────────────────
app.post('/api/immich/import-video', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  const { immichUrl, immichKey, assetId, filename } = req.body;
  if (!immichUrl || !immichKey || !assetId) {
    return res.status(400).json({ error: 'Missing required params' });
  }
  try {
    const dlRes = await fetch(
      `${immichUrl.replace(/\/$/, '')}/api/assets/${assetId}/original`,
      { headers: { 'x-api-key': immichKey } }
    );
    if (!dlRes.ok) return res.status(500).json({ error: 'Failed to download from Immich' });

    const contentType  = dlRes.headers.get('content-type') || 'video/mp4';
    const buffer       = await dlRes.buffer();
    const safeFilename = filename || `immich-${assetId}.mp4`;

    const uploadRes  = await uploadMedia(apiKey, buffer, safeFilename, contentType);
    const uploadData = await uploadRes.json();
    if (!uploadRes.ok) return res.status(500).json({ error: uploadData.errors?.[0]?.message || 'Ghost upload failed' });

    const ghost = uploadData.media?.[0] || {};
    return res.json({ success: true, media: { ...ghost, name: ghost.ref || safeFilename, size: buffer.length, mtime: Date.now(), thumbUrl: null } });
  } catch {
    return res.status(500).json({ error: 'Transfer failed' });
  }
});

// â”€â”€â”€ AI helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function requireAi(res) {
  if (!ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'AI features require ANTHROPIC_API_KEY in .env' });
    return false;
  }
  return true;
}

// Strip HTML to plain text for AI context
function htmlToText(html) {
  return (html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Count non-text card types in a Lexical document (for AI media inventory).
// Returns e.g. "Post contains: 1 video card, 2 image cards" or "no media cards".
function buildMediaInventory(lexicalJson) {
  if (!lexicalJson) return 'no media cards';
  let doc;
  try { doc = JSON.parse(lexicalJson); } catch { return 'no media cards'; }
  const counts = {};
  function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type && !['paragraph', 'heading', 'root'].includes(node.type)) {
      counts[node.type] = (counts[node.type] || 0) + 1;
    }
    for (const k of Object.keys(node)) {
      const child = node[k];
      if (Array.isArray(child)) child.forEach(walk);
      else if (child && typeof child === 'object') walk(child);
    }
  }
  walk(doc.root);
  const parts = Object.entries(counts).map(([type, n]) => `${n} ${type} card${n !== 1 ? 's' : ''}`);
  return parts.length ? `Post contains: ${parts.join(', ')}` : 'no media cards';
}

// â”€â”€ AI: generate excerpt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/ai/excerpt', requireGhostAuth, aiExcerptLimiter, async (req, res) => {
  if (!requireAi(res)) return;
  const apiKey = req.apiKey;
  const { postId, postType } = req.body;
  if (!postId || !postType) return res.status(400).json({ error: 'Missing postId or postType' });
  if (!['posts', 'pages'].includes(postType)) return res.status(400).json({ error: 'Invalid postType' });

  try {
    // Fetch the full post from Ghost
    const FIELDS = 'id,title,html,meta_description';
    const r = await ghostRequest(apiKey, `/${postType}/${postId}/?fields=${FIELDS}`);
    if (!r.ok) return res.status(r.status).json({ error: `Ghost error ${r.status}` });
    const data = await r.json();
    const post = (data[postType] || [])[0];
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const bodyText = htmlToText(post.html).slice(0, 4000);
    const prompt =
      `You are an expert blog editor. Write a compelling excerpt (1â€“2 sentences, max 300 characters) ` +
      `for the following blog post. Return ONLY the excerpt text, no quotes, no explanation.\n\n` +
      `Title: ${post.title}\n\nContent:\n${bodyText}`;

    const message = await getAnthropicClient().messages.create({
      model:      AI_MODEL_TEXT,
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    });

    const excerpt = (message.content[0]?.text || '').trim();
    return res.json({ excerpt });
  } catch (e) {
    logError('POST /api/ai/excerpt', e);
    return res.status(500).json({ error: e.message || 'AI request failed' });
  }
});

// â”€â”€ AI: improve post â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/ai/improve', requireGhostAuth, aiImproveLimiter, async (req, res) => {
  if (!requireAi(res)) return;
  const apiKey = req.apiKey;
  const { postId, postType } = req.body;
  if (!postId || !postType) return res.status(400).json({ error: 'Missing postId or postType' });
  if (!['posts', 'pages'].includes(postType)) return res.status(400).json({ error: 'Invalid postType' });

  const VALID_FIELDS = ['title', 'excerpt', 'meta_title', 'meta_description', 'tags', 'body'];
  const requestedFields = Array.isArray(req.body.fields) && req.body.fields.length > 0
    ? req.body.fields.filter(f => VALID_FIELDS.includes(f))
    : ['title', 'excerpt', 'meta_title', 'meta_description'];
  const instructions = (req.body.instructions || '').trim().slice(0, 500);
  const language     = (req.body.language || 'en').slice(0, 10);
  const bodyMode     = ['feedback', 'generate'].includes(req.body.bodyMode) ? req.body.bodyMode : 'feedback';
  const bodyLength   = ['short', 'medium', 'long'].includes(req.body.bodyLength) ? req.body.bodyLength : 'medium';

  try {
    const needsLexical = requestedFields.includes('body') && bodyMode === 'generate';
    const FIELDS = 'id,title,html,custom_excerpt,excerpt,meta_title,meta_description' + (needsLexical ? ',lexical' : '');
    const formatQS = needsLexical ? '&formats=lexical' : '';
    const [postRes, allTagsRaw] = await Promise.all([
      ghostRequest(apiKey, `/${postType}/${postId}/?fields=${FIELDS}&include=tags${formatQS}`),
      requestedFields.includes('tags') ? ghostFetchAll(apiKey, 'tags', 'name') : Promise.resolve([]),
    ]);
    if (!postRes.ok) return res.status(postRes.status).json({ error: `Ghost error ${postRes.status}` });
    const data = await postRes.json();
    const post = (data[postType] || [])[0];
    if (!post) return res.status(404).json({ error: 'Post not found' });
    const allTagNames = allTagsRaw.map(t => t.name);

    const LANG_LABELS_IMPROVE = {
      en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
      pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ja: 'Japanese', zh: 'Chinese', ko: 'Korean',
    };
    const languageLabel = LANG_LABELS_IMPROVE[language] || language;

    // Build JSON shape dynamically based on requested fields
    const jsonParts = [];
    if (requestedFields.includes('title'))
      jsonParts.push('  "title": "improved title (max 70 chars) or null if already good"');
    if (requestedFields.includes('excerpt'))
      jsonParts.push('  "excerpt": "improved excerpt (1-2 sentences, max 300 chars) or null if already good"');
    if (requestedFields.includes('meta_title'))
      jsonParts.push('  "meta_title": "SEO meta title (max 60 chars) or null if already good"');
    if (requestedFields.includes('meta_description'))
      jsonParts.push('  "meta_description": "SEO meta description (max 160 chars) or null if already good"');
    if (requestedFields.includes('tags'))
      jsonParts.push('  "tags_to_add": ["up to 5 tags — ONLY choose from the Available tags list, do NOT invent new tags"],\n  "tags_to_remove": ["existing tag names that are irrelevant or low quality — use exact existing names"]');
    if (requestedFields.includes('body') && bodyMode !== 'generate')
      jsonParts.push('  "body_feedback": "3-5 sentences of structured feedback about structure, clarity, and readability"');
    jsonParts.push('  "feedback": "2-4 sentences of general editorial feedback about quality and SEO"');

    // Build context lines dynamically
    const contextLines = [];
    if (requestedFields.includes('title'))
      contextLines.push(`Current title: ${post.title}`);
    if (requestedFields.includes('excerpt'))
      contextLines.push(`Current excerpt: ${post.custom_excerpt || post.excerpt || '(none)'}`);
    if (requestedFields.includes('meta_title'))
      contextLines.push(`Current meta_title: ${post.meta_title || '(none)'}`);
    if (requestedFields.includes('meta_description'))
      contextLines.push(`Current meta_description: ${post.meta_description || '(none)'}`);
    if (requestedFields.includes('tags')) {
      const tagList = (post.tags || []).map(t => t.name).join(', ') || 'none';
      contextLines.push(`Current tags: ${tagList}`);
      contextLines.push(`Available tags: ${allTagNames.join(', ') || '(none)'}`);
    }

    let bodySection = '';
    if (requestedFields.includes('body')) {
      const bodyText = htmlToText(post.html).slice(0, 6000);
      bodySection = `\n\nPost content:\n${bodyText}`;
    }

    const instructionsLine = instructions ? `\n\nAdditional instructions: ${instructions}` : '';

    const prompt =
      `You are an expert blog editor and SEO specialist. Analyse the following blog post and return a JSON object with improvement suggestions. ` +
      `IMPORTANT: You MUST write ALL text values inside the JSON in ${languageLabel}. Do not use any other language for the output values. Return ONLY valid JSON, no markdown fences, no explanation.\n\n` +
      `Required JSON shape:\n{\n${jsonParts.join(',\n')}\n}\n\n` +
      contextLines.join('\n') +
      bodySection +
      instructionsLine;

    const maxTokens = (requestedFields.includes('body') && bodyMode !== 'generate') ? 1200 : 800;
    const message = await getAnthropicClient().messages.create({
      model:      AI_MODEL_TEXT,
      max_tokens: maxTokens,
      messages:   [{ role: 'user', content: prompt }],
    });

    let raw = (message.content[0]?.text || '').trim();
    // Strip optional markdown code fences
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let suggestions;
    try {
      suggestions = JSON.parse(raw);
    } catch {
      suggestions = {
        title: null, excerpt: null, meta_title: null, meta_description: null,
        tags_to_add: [], tags_to_remove: [], body_feedback: null, feedback: raw,
      };
    }

    // Filter tags_to_add to only include existing Ghost tags
    if (Array.isArray(suggestions.tags_to_add) && allTagNames.length > 0) {
      const lowerAvailable = allTagNames.map(n => n.toLowerCase());
      suggestions.tags_to_add = suggestions.tags_to_add
        .filter(name => typeof name === 'string' && lowerAvailable.includes(name.toLowerCase()));
    }

    // ── Generate content mode ─────────────────────────────────────────────────
    let generated = null;
    let wordCount = 0;
    let warnExistingContent = false;

    if (requestedFields.includes('body') && bodyMode === 'generate') {
      wordCount = htmlToText(post.html).split(/\s+/).filter(Boolean).length;
      warnExistingContent = wordCount > 200;

      const mediaInventory = buildMediaInventory(post.lexical);

      const LANG_LABELS_CONTENT = {
        en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
        pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ja: 'Japanese', zh: 'Chinese', ko: 'Korean',
        'de-AT': 'German', 'de-CH': 'German', 'en-US': 'English', 'en-GB': 'English',
      };
      const langLabel = LANG_LABELS_CONTENT[language] || language;

      const tokenBudget = { short: 1200, medium: 2000, long: 3000 };
      const genMaxTokens = tokenBudget[bodyLength] || 2000;
      const genModel = AI_MODEL_CONTENT || AI_MODEL_TEXT;

      const tagNames = (post.tags || []).map(t => t.name).join(', ') || 'none';
      const excerptText = post.custom_excerpt || post.excerpt || '';
      const lengthHints = { short: '100–150 words', medium: '250–350 words', long: '400–500 words' };
      const lengthHint = lengthHints[bodyLength] || '250–350 words';

      const genPrompt =
        `You are an expert blog content writer. Write new text paragraphs for a blog post based on the information below. ` +
        `Write in ${langLabel}. Total content length should be approximately ${lengthHint}. ` +
        `Return ONLY a valid JSON object with three string fields: "intro", "body", "outro". ` +
        `Any field may be null if not needed. Use plain text only \u2014 no markdown, no HTML. ` +
        `Separate paragraphs within a section with a blank line (double newline).\n` +
        `IMPORTANT: Write ALL content in ${langLabel}. Return ONLY valid JSON, no markdown fences, no explanation.\n\n` +
        `Required JSON shape:\n{ "intro": "...", "body": "...", "outro": "..." }\n\n` +
        `Post title: ${post.title}\n` +
        `Tags: ${tagNames}\n` +
        (excerptText ? `Excerpt: ${excerptText}\n` : '') +
        `Media in post: ${mediaInventory}\n` +
        (instructions ? `\nAdditional instructions: ${instructions}` : '');

      const genMessage = await getAnthropicClient().messages.create({
        model:      genModel,
        max_tokens: genMaxTokens,
        messages:   [{ role: 'user', content: genPrompt }],
      });

      let genRaw = (genMessage.content[0]?.text || '').trim();
      genRaw = genRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      try {
        generated = JSON.parse(genRaw);
      } catch {
        generated = { intro: null, body: genRaw || null, outro: null };
      }
    }

    const response = {
      suggestions,
      post: {
        title:            post.title,
        excerpt:          post.custom_excerpt || post.excerpt || '',
        meta_title:       post.meta_title || '',
        meta_description: post.meta_description || '',
        tags:             post.tags || [],
      },
    };
    if (generated !== null) {
      response.generated           = generated;
      response.wordCount           = wordCount;
      response.warnExistingContent = warnExistingContent;
    }
    return res.json(response);
  } catch (e) {
    logError('POST /api/ai/improve', e);
    return res.status(500).json({ error: e.message || 'AI request failed' });
  }
});

// ── AI: apply generated body content ─────────────────────────────────────────
// Inserts AI-generated paragraph nodes into a post's Lexical document.
// No AI call — reads current Lexical, inserts nodes, writes back to Ghost.
app.post('/api/ai/apply-body', requireGhostAuth, aiImproveLimiter, async (req, res) => {
  const apiKey = req.apiKey;
  const { postId, postType, updated_at, intro, body, outro } = req.body;

  if (!postId || !postType)                    return res.status(400).json({ error: 'Missing postId or postType' });
  if (!['posts', 'pages'].includes(postType))  return res.status(400).json({ error: 'Invalid postType' });
  if (!updated_at)                             return res.status(400).json({ error: 'updated_at is required' });
  if (!intro && !body && !outro)               return res.status(400).json({ error: 'At least one of intro, body, outro is required' });

  try {
    const r = await ghostRequest(apiKey, `/${postType}/${postId}/?fields=id,lexical&formats=lexical`);
    if (!r.ok) return res.status(r.status).json({ error: `Ghost error ${r.status}` });
    const data = await r.json();
    const post = (data[postType] || [])[0];
    if (!post) return res.status(404).json({ error: 'Post not found' });
    if (!post.lexical) return res.status(422).json({ error: 'Post has no Lexical content \u2014 cannot insert paragraphs' });

    const newLexical = insertParagraphNodes(post.lexical, {
      intro: intro || null, body: body || null, outro: outro || null,
    });

    const putRes = await ghostRequest(apiKey, `/${postType}/${postId}/`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ [postType]: [{ id: postId, lexical: newLexical, updated_at }] }),
    });

    if (putRes.status === 409) {
      return res.status(409).json({ error: 'The post was edited elsewhere \u2014 please reload.' });
    }
    if (!putRes.ok) {
      const errData = await putRes.json().catch(() => ({}));
      return res.status(putRes.status).json({ error: errData.errors?.[0]?.message || `Ghost error ${putRes.status}` });
    }

    const putData = await putRes.json();
    const updated = (putData[postType] || [])[0];
    return res.json({ success: true, updated_at: updated?.updated_at });
  } catch (e) {
    logError('POST /api/ai/apply-body', e);
    return res.status(500).json({ error: e.message || 'Apply failed' });
  }
});

// â”€â”€ AI: create post from images â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/ai/create-from-images', requireGhostAuth, aiCreateLimiter, async (req, res) => {
  if (!requireAi(res)) return;

  // Accept prompt (required). Backwards-compat: 'context' maps to 'prompt'.
  const prompt = ((req.body.prompt || req.body.context) || '').trim();
  if (!prompt)
    return res.status(400).json({ error: 'prompt is required' });

  const imageUrls = Array.isArray(req.body.imageUrls) ? req.body.imageUrls : [];
  const videoUrls = Array.isArray(req.body.videoUrls) ? req.body.videoUrls : [];
  const pdfUrls   = Array.isArray(req.body.pdfUrls)   ? req.body.pdfUrls   : [];
  const language  = (req.body.language || 'en').slice(0, 10);

  if (imageUrls.length + videoUrls.length > 10)
    return res.status(400).json({ error: 'Maximum 10 images/videos per request' });

  // SSRF: all URLs must be same-origin (starts with Ghost URL or is a relative path)
  const allowedOrigin = GHOST_URL.replace(/\/$/, '');
  for (const url of [...imageUrls, ...videoUrls, ...pdfUrls]) {
    if (!url.startsWith(allowedOrigin + '/') && !url.startsWith('/')) {
      return res.status(400).json({ error: `URL not from configured Ghost instance: ${url}` });
    }
  }

  try {
    const allTagsRaw = await ghostFetchAll(apiKey, 'tags', 'name');
    const allTagNames = allTagsRaw.map(t => t.name);

    const contentParts = [];

    // ── Images → base64
    if (imageUrls.length > 0) {
      const parts = await Promise.all(imageUrls.map(async (url) => {
        const fullUrl = url.startsWith('/') ? `${allowedOrigin}${url}` : url;
        const r = await fetch(fullUrl);
        if (!r.ok) throw new Error(`Failed to fetch image: ${url} (${r.status})`);
        const contentType = r.headers.get('content-type') || 'image/jpeg';
        const mimeType = contentType.split(';')[0].trim();
        const buffer = await r.buffer();
        return { type: 'image', source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') } };
      }));
      contentParts.push(...parts);
    }

    // ── Videos → extract thumbnail frame, send as image + label
    if (videoUrls.length > 0) {
      const parts = await Promise.all(videoUrls.map(async (url, i) => {
        const fullUrl = url.startsWith('/') ? `${allowedOrigin}${url}` : url;
        const filename = path.basename(new URL(fullUrl).pathname) || `video_${i}.mp4`;
        const r = await fetch(fullUrl);
        if (!r.ok) throw new Error(`Failed to fetch video: ${url} (${r.status})`);
        const buffer = await r.buffer();
        const { thumbBuf } = await extractVideoFrame(buffer, filename);
        return [
          { type: 'text', text: `[Video ${i + 1}: ${filename}]` },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: thumbBuf.toString('base64') } },
        ];
      }));
      contentParts.push(...parts.flat());
    }

    // ── PDFs → base64 document
    if (pdfUrls.length > 0) {
      const parts = await Promise.all(pdfUrls.map(async (url, i) => {
        const fullUrl = url.startsWith('/') ? `${allowedOrigin}${url}` : url;
        const filename = path.basename(new URL(fullUrl).pathname) || `document_${i}.pdf`;
        const r = await fetch(fullUrl);
        if (!r.ok) throw new Error(`Failed to fetch PDF: ${url} (${r.status})`);
        const buffer = await r.buffer();
        return [
          { type: 'text', text: `[PDF document: ${filename}]` },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
        ];
      }));
      contentParts.push(...parts.flat());
    }

    // ── Instruction prompt
    const LANG_LABELS = {
      en: 'English', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian',
      pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ja: 'Japanese', zh: 'Chinese', ko: 'Korean',
    };
    const languageLabel = LANG_LABELS[language] || language;

    let mediaDesc = '';
    if (imageUrls.length > 0) mediaDesc += ` ${imageUrls.length} image(s)`;
    if (videoUrls.length > 0) mediaDesc += ` ${videoUrls.length} video thumbnail(s)`;
    if (pdfUrls.length > 0)   mediaDesc += ` ${pdfUrls.length} PDF document(s)`;

    contentParts.push({
      type: 'text',
      text:
        `You are an expert blog writer. Write all content in ${languageLabel}.\n` +
        `User prompt: "${prompt}"${mediaDesc ? `\nProvided media:${mediaDesc}.` : ''}\n\n` +
        `Create a compelling blog post draft. Return ONLY valid JSON, no markdown fences, no explanation.\n\n` +
        `Required JSON shape:\n` +
        `{\n` +
        `  "title": "engaging post title",\n` +
        `  "excerpt": "1-2 sentence excerpt (max 300 chars)",\n` +
        `  "html": "full blog post body as HTML (use <h2>, <p>, <ul> etc).` +
        (imageUrls.length > 0 ? ' Include images using <img> tags with the provided URLs in logical positions.' : '') +
        `",\n` +
        `  "tags": ["tag1", "tag2"]  // 2-4 tags — ONLY pick from the Available tags list below, do NOT invent new tags\n` +
        `}\n\n` +
        (imageUrls.length > 0 ? `Image URLs:\n${imageUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}\n\n` : '') +
        (videoUrls.length > 0 ? `Video URLs:\n${videoUrls.map((u, i) => `${i + 1}. ${u}`).join('\n')}\n\n` : '') +
        (pdfUrls.length > 0   ? `PDF URLs:\n${pdfUrls.map((u, i)   => `${i + 1}. ${u}`).join('\n')}\n\n` : '') +
        `Available tags: ${allTagNames.join(', ') || '(none)'}`,
    });

    // Use vision model only when there are images or videos; text model suffices for text+PDFs
    const hasVisualMedia = imageUrls.length + videoUrls.length > 0;
    const selectedModel  = hasVisualMedia ? AI_MODEL_VISION : AI_MODEL_TEXT;

    const message = await getAnthropicClient().messages.create({
      model:      selectedModel,
      max_tokens: 2000,
      messages:   [{ role: 'user', content: contentParts }],
    });

    let raw = (message.content[0]?.text || '').trim();
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

    let draft;
    try {
      draft = JSON.parse(raw);
    } catch {
      draft = { title: 'New Post', excerpt: '', html: raw, tags: [] };
    }

    // Filter tags to only include existing Ghost tags
    if (Array.isArray(draft.tags) && allTagNames.length > 0) {
      const lowerAvailable = allTagNames.map(n => n.toLowerCase());
      draft.tags = draft.tags
        .filter(name => typeof name === 'string' && lowerAvailable.includes(name.toLowerCase()));
    }

    return res.json({ draft });
  } catch (e) {
    logError('POST /api/ai/create-from-images', e);
    return res.status(500).json({ error: e.message || 'AI request failed' });
  }
});

// â”€â”€ Posts: create new draft â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/posts/create', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  const { title, excerpt, html, featureImageUrl, tags } = req.body;
  if (!title)  return res.status(400).json({ error: 'Missing title' });

  const postPayload = {
    title:   title.trim(),
    status:  'draft',
  };

  if (excerpt)        postPayload.custom_excerpt = excerpt.trim().slice(0, 300);
  if (html)           postPayload.html           = html;
  if (featureImageUrl) postPayload.feature_image = featureImageUrl;

  // Tags: accept array of string names or {id, name} objects
  if (Array.isArray(tags) && tags.length > 0) {
    postPayload.tags = tags.map(t =>
      typeof t === 'string' ? { name: t } : { name: t.name || t.id }
    );
  }

  try {
    const r = await ghostRequest(apiKey, '/posts/?source=html', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ posts: [postPayload] }),
    });
    const data = await r.json();
    if (r.status === 401) return res.status(401).json({ error: 'Unauthorized' });
    if (!r.ok)            return res.status(r.status).json({ error: data.errors?.[0]?.message || 'Create failed' });
    const created = data.posts?.[0];
    return res.json({ post: { id: created.id, url: created.url, title: created.title, status: created.status } });
  } catch (e) {
    logError('POST /api/posts/create', e);
    return res.status(500).json({ error: 'Network error' });
  }
});

// â”€â”€â”€ POST /api/tools/parse-wordpress-xml â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/tools/parse-wordpress-xml', (req, res) => {
  uploadXml(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No XML file uploaded' });

    try {
      const parser = new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        cdataPropName: '__cdata',
        textNodeName: '#text',
        isArray: (name) => ['item', 'category', 'wp:postmeta', 'wp:comment'].includes(name),
      });

      const parsed = parser.parse(req.file.buffer);
      const channel = parsed?.rss?.channel;
      if (!channel) return res.status(422).json({ error: 'Invalid WordPress XML: no rss.channel found' });

      const items = Array.isArray(channel.item) ? channel.item : (channel.item ? [channel.item] : []);

      // Build attachment map: post_id â†’ { url, filename }
      const attachments = {};
      for (const item of items) {
        if (cdataStr(item['wp:post_type']) === 'attachment') {
          const id  = String(item['wp:post_id']);
          const url = cdataStr(item['wp:attachment_url']);
          if (id && url) attachments[id] = { url, filename: path.basename(url.split('?')[0]) };
        }
      }

      // Count media by type
      const mediaCount = { images: 0, videos: 0, other: 0 };
      for (const att of Object.values(attachments)) {
        const ext = path.extname(att.filename).toLowerCase();
        if (/\.(jpg|jpeg|png|gif|webp|svg|ico)$/.test(ext))  mediaCount.images++;
        else if (/\.(mp4|mov|avi|webm|mkv|m4v)$/.test(ext))  mediaCount.videos++;
        else if (ext)                                          mediaCount.other++;
      }

      // Categorize content items, discarding trash immediately
      const sessionItems = [];
      let countPublished = 0, countDrafts = 0, countPages = 0;

      for (const item of items) {
        const type   = cdataStr(item['wp:post_type']);
        const status = cdataStr(item['wp:status']);
        if (type === 'attachment') continue;
        if (status === 'trash')    continue;
        if (!['post', 'page'].includes(type)) continue;

        const metas   = Array.isArray(item['wp:postmeta']) ? item['wp:postmeta'] : (item['wp:postmeta'] ? [item['wp:postmeta']] : []);
        const thumbM  = metas.find(m => cdataStr(m['wp:meta_key']) === '_thumbnail_id');
        const thumbId = thumbM ? String(cdataStr(thumbM['wp:meta_value'])) : null;
        const thumbUrl = thumbId && attachments[thumbId] ? attachments[thumbId].url : null;

        const tags = (Array.isArray(item.category) ? item.category : []).filter(Boolean)
          .map(c => (c.__cdata || c['#text'] || '').trim()).filter(Boolean);

        sessionItems.push({
          id:          String(item['wp:post_id']),
          type,
          status,
          title:       decodeHtmlEntities(cdataStr(item.title)) || '(Untitled)',
          slug:        cdataStr(item['wp:post_name']),
          content:     cdataStr(item['content:encoded']),
          excerpt:     cleanExcerpt(cdataStr(item['excerpt:encoded'])),
          publishedAt: wpDateToIso(cdataStr(item['wp:post_date_gmt']) || cdataStr(item['wp:post_date'])),
          thumbUrl,
          tags,
        });

        if (type === 'page')            countPages++;
        else if (status === 'publish')  countPublished++;
        else if (status === 'draft')    countDrafts++;
      }

      const token = crypto.randomUUID();
      wpSessions.set(token, { items: sessionItems, attachments, createdAt: Date.now() });

      return res.json({
        sessionToken: token,
        summary: {
          published: countPublished,
          drafts:    countDrafts,
          pages:     countPages,
          media:     mediaCount,
          total:     sessionItems.length,
        },
      });
    } catch (e) {
      logError('POST /api/tools/parse-wordpress-xml', e);
      return res.status(500).json({ error: 'Parse error: ' + e.message });
    }
  });
});

// --- POST /api/tools/import-wordpress (SSE stream) ---

// SSRF guard: only allow http/https, block private ranges, skip Ghost-origin URLs
function isAllowedMediaUrl(urlStr, allowedHostname) {
  try {
    const u = new URL(urlStr);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const h = u.hostname;
    if (/^(localhost|127\.|10\.|169\.254\.)/.test(h)) return false;
    if (/^172\.(1[6-9]|2\d|30|31)\./.test(h))         return false;
    if (/^192\.168\./.test(h))                          return false;
    if (/^::1$/.test(h))                                return false;
    if (GHOST_URL && urlStr.startsWith(GHOST_URL))      return false;
    if (allowedHostname && h !== allowedHostname)        return false;
    return true;
  } catch { return false; }
}

app.post('/api/tools/import-wordpress', requireGhostAuth, async (req, res) => {
  const apiKey = req.apiKey;
  const { sessionToken, options = {}, testSlug } = req.body;
  if (!sessionToken)
    return res.status(400).json({ error: 'sessionToken is required' });
  const testMode = typeof testSlug === 'string' && testSlug.trim() !== '';
  console.log('[WP IMPORT] testMode =', testMode);

  const session = wpSessions.get(sessionToken);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });

  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  function sendEvent(data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

  let aborted = false;
  res.on('close', () => { aborted = true; }); // fires on actual client disconnect, not on POST body read

  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': keepalive\n\n');
  }, 15000);

  try {
    const { items, attachments } = session;

    let allowedHostname = null;
    const firstAtt = Object.values(attachments)[0];
    if (firstAtt) { try { allowedHostname = new URL(firstAtt.url).hostname; } catch {} }

    const filteredItems = items.filter(item => {
      if (item.type === 'page')      return !!options.pages;
      if (item.status === 'publish') return !!options.published;
      if (item.status === 'draft')   return !!options.drafts;
      return false;
    });

    // Test mode: restrict to a single post by slug
    const workItems = testMode
      ? filteredItems.filter(item => item.slug === testSlug.trim())
      : filteredItems;

    if (testMode) {
      console.log('[WP IMPORT] testSlug.trim()=', JSON.stringify(testSlug.trim()));
      console.log('[WP IMPORT] filteredItems.length=', filteredItems.length);
      console.log('[WP IMPORT] workItems.length=', workItems.length);
      console.log('[WP IMPORT] first 5 slugs:', filteredItems.slice(0, 5).map(i => i.slug));
      const hit = filteredItems.find(i => i.slug === testSlug.trim());
      console.log('[WP IMPORT] exact match:', hit ? hit.slug : 'NOT FOUND');
      sendEvent({ type: 'debug', message: `[DIAG] filteredItems: ${filteredItems.length}` });
      sendEvent({ type: 'debug', message: `[DIAG] workItems: ${workItems.length}` });
      sendEvent({ type: 'debug', message: `[DIAG] first 5 slugs: ${filteredItems.slice(0, 5).map(i => i.slug).join(', ')}` });
      sendEvent({ type: 'debug', message: `[DIAG] exact match: ${filteredItems.find(i => i.slug === testSlug.trim())?.slug ?? 'NOT FOUND'}` });
      if (workItems.length === 0) {
        sendEvent({ type: 'error', message: `Post with slug '${testSlug.trim()}' not found` });
        sendEvent({ type: 'complete', imported: 0, failed: 0, mediaUploaded: 0, mediaFailed: 0 });
        clearInterval(heartbeat); res.end(); return;
      }
      sendEvent({ type: 'info', message: `[TEST] Single-post mode — "${workItems[0].title}" (slug: ${workItems[0].slug})` });
    }

    if (workItems.length === 0) {
      sendEvent({ type: 'complete', imported: 0, failed: 0, mediaUploaded: 0, mediaFailed: 0,
                  message: 'No items matched the selected options' });
      clearInterval(heartbeat); res.end(); return;
    }

    // Phase 1: Pre-process posts
    const postData     = [];
    const allMediaUrls = new Set();

    for (const item of workItems) {
      const { html: rawHtml, coverUrl, mediaUrls } = convertGutenbergToHtml(item.content);
      // Strip any <img> tags whose src isn't a valid http URL (WP upload placeholders, blob:, etc.)
      const html = rawHtml.replace(/<img[^>]+>/gi, tag =>
        (/src="https?:\/\//i.test(tag) ? tag : ''));
      const featureImageUrl = coverUrl || item.thumbUrl || null;
      const wpVideoUrls = mediaUrls.filter(u => /\.(mp4|mov|avi|webm|mkv|m4v)$/i.test(u.split('?')[0]));
      postData.push({ item, html, featureImageUrl, wpVideoUrls });
      for (const u of mediaUrls) allMediaUrls.add(u);
      if (item.thumbUrl) allMediaUrls.add(item.thumbUrl);
      if (coverUrl)      allMediaUrls.add(coverUrl);
      // Catch inline <img src="..."> from classic-editor / non-Gutenberg HTML passed through
      const inlineSrcRe = /<img[^>]+src="(https?:\/\/[^"]+)"[^>]*>/gi;
      let im;
      while ((im = inlineSrcRe.exec(html)) !== null) allMediaUrls.add(im[1]);
      // Belt-and-suspenders: also scan raw WP content for any image/video URLs the converter may have missed
      const rawSrcRe = /src="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|gif|webp|svg|mp4|mov|webm))(?:[?#][^"]*)?(?:")/gi;
      let rm;
      while ((rm = rawSrcRe.exec(item.content)) !== null) allMediaUrls.add(rm[1]);

      if (testMode) {
        const found = [...allMediaUrls];
        sendEvent({ type: 'debug', message: `[DEBUG] ${found.length} media URL(s) found in post:` });
        found.forEach((u, i) => sendEvent({ type: 'debug', message: `  [${i + 1}] ${u}` }));
      }
    }

    // Phase 2: Media migration
    const urlMap        = new Map();
    const thumbnailMap  = new Map(); // oldVideoUrl -> Ghost thumbnail URL
    const videoMetaMap  = new Map(); // oldVideoUrl -> { width, height, duration }
    const dimensionsMap = new Map(); // oldImageUrl -> { width, height }
    const mediaList = [...allMediaUrls];
    let mediaUploaded = 0, mediaFailed = 0;

    if (options.migrateMedia && mediaList.length > 0) {
      sendEvent({ type: 'media', current: 0, total: mediaList.length,
                  message: `Collecting ${mediaList.length} media files...` });

      for (let mi = 0; mi < mediaList.length; mi++) {
        if (aborted) break;
        const oldUrl = mediaList[mi];

        if (GHOST_URL && oldUrl.startsWith(GHOST_URL)) { urlMap.set(oldUrl, oldUrl); continue; }

        if (!isAllowedMediaUrl(oldUrl, allowedHostname)) {
          const fn = path.basename(oldUrl.split('?')[0]);
          sendEvent({ type: 'media', current: mi + 1, total: mediaList.length,
                      message: `Skipped (blocked URL): ${fn}` });
          mediaFailed++;
          continue;
        }

        const filename = path.basename(new URL(oldUrl).pathname);
        if (testMode)
          sendEvent({ type: 'debug', message: `Attempting download: ${oldUrl}` });
        else
          sendEvent({ type: 'media', current: mi + 1, total: mediaList.length,
                      message: `Uploading: ${filename}` });

        try {
          const dlRes = await fetch(oldUrl, { signal: AbortSignal.timeout(30000) });
          if (!dlRes.ok) throw new Error(`HTTP ${dlRes.status}`);
          const buffer = Buffer.from(await dlRes.arrayBuffer());

          const ext      = path.extname(filename).toLowerCase();
          const isVideo  = /\.(mp4|mov|avi|webm|mkv|m4v)$/.test(ext);
          const endpoint = isVideo ? '/media/upload' : '/images/upload';

          const form = new FormData();
          form.append('file', buffer, {
            filename,
            contentType: dlRes.headers.get('content-type') || 'application/octet-stream',
          });
          let videoMeta = null;
          if (isVideo) {
            form.append('ref', filename);
            // Extract a real frame at 0.5s using ffmpeg — same as Ghost's browser Canvas approach.
            videoMeta = await extractVideoFrame(buffer, filename);
            form.append('thumbnail', videoMeta.thumbBuf, { filename: filename + '.jpg', contentType: 'image/jpeg' });
          }

          const upRes  = await ghostRequest(apiKey, endpoint, {
            method: 'POST', body: form, headers: form.getHeaders(),
          });
          const upData = await upRes.json();
          if (!upRes.ok) throw new Error(upData.errors?.[0]?.message || 'Upload failed');

          const newUrl      = upData.images?.[0]?.url || upData.media?.[0]?.url;
          const thumbUrl    = upData.media?.[0]?.thumbnail_url || null;  // API returns snake_case
          if (newUrl) {
            urlMap.set(oldUrl, newUrl);
            if (thumbUrl) thumbnailMap.set(oldUrl, thumbUrl);
            if (videoMeta) videoMetaMap.set(oldUrl, { width: videoMeta.width, height: videoMeta.height, duration: videoMeta.duration });
            if (!isVideo) {
              try {
                const imgMeta = await sharp(buffer).metadata();
                if (imgMeta.width && imgMeta.height) dimensionsMap.set(oldUrl, { width: imgMeta.width, height: imgMeta.height });
              } catch (_) { /* sharp can't read this format — dimensions omitted */ }
            }
            if (testMode)
              sendEvent({ type: 'debug', message: `✅ Uploaded to Ghost: ${newUrl}` });
            mediaUploaded++;
          }
        } catch (e) {
          if (testMode)
            sendEvent({ type: 'debug', message: `❌ Failed: ${oldUrl} — ${e.message}` });
          else
            sendEvent({ type: 'media', current: mi + 1, total: mediaList.length,
                        message: `Failed: ${filename} -- ${e.message}` });
          mediaFailed++;
        }
      }
    }

    // Phase 3: Create posts/pages in Ghost
    let imported = 0, failed = 0;
    const importLog = [];

    for (let pi = 0; pi < postData.length; pi++) {
      if (aborted) break;
      const { item, html, featureImageUrl, wpVideoUrls } = postData[pi];
      sendEvent({ type: 'progress', current: pi + 1, total: postData.length,
                  message: `Importing: ${item.title}` });

      try {
        let finalHtml = html;
        for (const [oldUrl, newUrl] of urlMap) {
          finalHtml = finalHtml.split(oldUrl).join(newUrl);
        }

        // Inject width/height so Ghost's HTML parser sets Lexical image node dimensions
        for (const [oldUrl, dims] of dimensionsMap) {
          const newUrl = urlMap.get(oldUrl);
          if (!newUrl) continue;
          const escapedUrl = newUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          finalHtml = finalHtml.replace(
            new RegExp(`(<img(?=[^>]*src="${escapedUrl}")[^>]*?)(/?>)`, 'g'),
            (_, before, end) => /\bwidth=/.test(before) ? _ : `${before} width="${dims.width}" height="${dims.height}"${end}`
          );
        }

        const finalFeatureImage = featureImageUrl
          ? (urlMap.get(featureImageUrl) || featureImageUrl)
          : null;

        const postObj = {
          title:  item.title,
          html:   finalHtml || null,
          slug:   item.slug  || undefined,
          status: item.status === 'publish' ? 'published' : 'draft',
          tags:   item.tags.map(name => ({ name })),
        };
        if (item.excerpt)      postObj.custom_excerpt = item.excerpt;
        if (finalFeatureImage) postObj.feature_image  = finalFeatureImage;
        if (item.status === 'publish' && item.publishedAt) postObj.published_at = item.publishedAt;

        const isPage   = item.type === 'page';
        const endpoint = isPage ? '/pages/?source=html' : '/posts/?source=html';
        const bodyKey  = isPage ? 'pages' : 'posts';

        const r    = await ghostRequest(apiKey, endpoint, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ [bodyKey]: [postObj] }),
        });
        const data = await r.json();
        if (!r.ok) throw new Error(data.errors?.[0]?.message || `HTTP ${r.status}`);

        const created = (data.posts || data.pages || [])[0];

        // Back-fill video src + thumbnailSrc in Lexical JSON (Ghost HTML parser doesn't extract <video src>)
        if (created?.id && wpVideoUrls.length > 0) {
          const ghostVideoUrls = wpVideoUrls.map(u => urlMap.get(u)).filter(Boolean);
          const ghostThumbUrls = wpVideoUrls.map(u => thumbnailMap.get(u) || '');
          const ghostVideoMeta = wpVideoUrls.map(u => videoMetaMap.get(u) || {});
          if (ghostVideoUrls.length > 0) {
            await patchVideoNodes(apiKey, created.id, isPage, ghostVideoUrls, ghostThumbUrls, ghostVideoMeta);
          }
        }

        importLog.push({ id: item.id, title: item.title, status: 'ok',
                         ghostId: created?.id, ghostUrl: created?.url });
        imported++;
      } catch (e) {
        importLog.push({ id: item.id, title: item.title, status: 'error', error: e.message });
        failed++;
        sendEvent({ type: 'error', message: `Failed: ${item.title} -- ${e.message}` });
      }

      if (!aborted && pi < postData.length - 1)
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    session.importLog = {
      completedAt: new Date().toISOString(),
      imported, failed, mediaUploaded, mediaFailed,
      items: importLog,
    };

    sendEvent({ type: 'complete', imported, failed, mediaUploaded, mediaFailed });

  } catch (e) {
    logError('POST /api/tools/import-wordpress', e);
    sendEvent({ type: 'error', message: 'Import failed: ' + e.message });
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// --- GET /api/tools/import-wordpress-log/:sessionToken ---
app.get('/api/tools/import-wordpress-log/:sessionToken', (req, res) => {
  const session = wpSessions.get(req.params.sessionToken);
  if (!session || !session.importLog) return res.status(404).json({ error: 'Log not found' });
  const ts = (session.importLog.completedAt || '').replace(/[:.]/g, '-').slice(0, 19) || 'log';
  res.setHeader('Content-Disposition', `attachment; filename="wp-import-log-${ts}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.json(session.importLog);
});

// â”€â”€â”€ Static files â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ── Make Landscape ───────────────────────────────────────────────────────────
// Converts a portrait feature image to a 16:9 landscape image, uploads it
// to Ghost, and updates the post's feature_image + feature_image_alt.
app.post('/api/posts/:id/make-landscape',
  requireGhostAuth,
  makeLandscapeLimiter,
  async (req, res) => {
    const apiKey = req.apiKey;
    const postId = req.params.id;

    // 1. Load post
    const post = await getPost(apiKey, 'posts', postId);
    if (!post)               return res.status(404).json({ error: 'Post not found' });
    if (!post.feature_image) return res.status(400).json({ error: 'No feature image set' });

    // 2. Read image into buffer (local fs first, remote fetch as fallback)
    let inputBuffer;
    try {
      const { absPath } = urlToContentPath(post.feature_image, 'images');
      inputBuffer = await fs.readFile(absPath);
    } catch {
      try {
        const r = await fetch(post.feature_image);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        inputBuffer = Buffer.from(await r.arrayBuffer());
      } catch (e) {
        return res.status(400).json({ error: `Cannot read image: ${e.message}` });
      }
    }

    // 3. Check portrait orientation
    const meta = await sharp(inputBuffer).metadata();
    if (meta.height <= meta.width) {
      return res.status(400).json({ error: 'Image is already landscape' });
    }

    // 4. Generate landscape buffer (no temp file)
    let outputBuffer;
    try {
      outputBuffer = await portraitToLandscape(inputBuffer);
    } catch (e) {
      logError('make-landscape/sharp', e);
      return res.status(500).json({ error: 'Image processing failed' });
    }

    // 5. Upload to Ghost
    const filename  = titleToFilename(post.title);
    const uploadRes = await uploadImage(apiKey, outputBuffer, filename, 'image/jpeg');
    if (!uploadRes.ok) {
      const err = await uploadRes.json().catch(() => ({}));
      return res.status(500).json({ error: err.errors?.[0]?.message || 'Upload failed' });
    }
    const uploadData = await uploadRes.json();
    const newUrl = uploadData.images?.[0]?.url;
    if (!newUrl) return res.status(500).json({ error: 'Upload succeeded but no URL returned' });

    // 6. Update post feature image + alt text
    const updateRes = await updatePost(apiKey, 'posts', postId, {
      feature_image:     newUrl,
      feature_image_alt: post.title,
      updated_at:        post.updated_at,
    });
    if (!updateRes.ok) {
      return res.status(500).json({ error: 'Image uploaded but post update failed' });
    }

    invalidateFsCache('images');
    return res.json({ success: true, url: newUrl });
  }
);

// ─── Global upload error handler ────────────────────────────────────────────
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Upload rejected: ${err.message}` });
  }
  if (err) {
    logError('multer', err);
    return res.status(500).json({ error: 'Upload failed' });
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// â”€â”€â”€ Start â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Ghost Media Manager  â†’  http://0.0.0.0:${PORT}`);
  console.log(`Ghost instance       â†’  ${GHOST_URL || '(not set!)'}`);
  let fsMounted = false;
  try { const e = await fs.readdir(GHOST_MEDIA_PATH); fsMounted = e.length > 0; } catch {}
  console.log(`Ghost images path    â†’  ${GHOST_MEDIA_PATH} (${fsMounted ? 'mounted âœ“' : 'not mounted â€“ delete/rename will be API-only'})`);
  let videoMounted = false;
  try { const e = await fs.readdir(GHOST_MEDIA_VIDEO_PATH); videoMounted = e.length > 0; } catch {}
  console.log(`Ghost media path     â†’  ${GHOST_MEDIA_VIDEO_PATH} (${videoMounted ? 'mounted âœ“' : 'not mounted â€“ video migration still works via API'})`);
  let filesMounted = false;
  try { const e = await fs.readdir(GHOST_MEDIA_FILES_PATH); filesMounted = e.length > 0; } catch {}
  console.log(`Ghost files path     →  ${GHOST_MEDIA_FILES_PATH} (${filesMounted ? 'mounted ✓' : 'not mounted'})`);
});
