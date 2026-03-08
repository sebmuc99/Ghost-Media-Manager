'use strict';

/**
 * server/lib/lexical.js
 * All operations on Ghost Lexical JSON documents.
 */

// ── walkLexical ───────────────────────────────────────────────────────────────
// Recursive tree walker. Calls visitor(node, parent, key) for every object node.
// parent and key are null for the root call.
function walkLexical(node, visitor, parent = null, key = null) {
  if (!node || typeof node !== 'object') return;
  visitor(node, parent, key);
  for (const k of Object.keys(node)) {
    const child = node[k];
    if (Array.isArray(child)) {
      child.forEach((item, i) => walkLexical(item, visitor, child, i));
    } else if (child && typeof child === 'object') {
      walkLexical(child, visitor, node, k);
    }
  }
}

// ── replaceUrlInLexical ───────────────────────────────────────────────────────
// Replace a URL throughout a Lexical document string.
//
// Rules (exact):
//   image nodes  (type === "image") : exact match on node.src only
//   video nodes  (type === "video") : exact match on node.src only
//   htmlCard     (type === "html")  : replaceAll within node.html
//   feature_image / og_image / twitter_image on root: exact match
//   NEVER substring-replace on typed node properties
//   NEVER touch the top-level html field
//
// Returns: { lexical: string, changed: boolean }
function replaceUrlInLexical(lexicalJson, oldUrl, newUrl) {
  let doc;
  try { doc = JSON.parse(lexicalJson); } catch { return { lexical: lexicalJson, changed: false }; }

  let changed = false;

  // Root-level POST fields (not part of Lexical tree) — exact match
  for (const field of ['feature_image', 'og_image', 'twitter_image']) {
    if (doc[field] === oldUrl) {
      doc[field] = newUrl;
      changed = true;
    }
  }

  walkLexical(doc.root, (node) => {
    if (node.type === 'image' || node.type === 'video') {
      if (node.src === oldUrl) {
        node.src = newUrl;
        changed = true;
      }
      return;
    }
    if (node.type === 'html') {
      if (typeof node.html === 'string' && node.html.includes(oldUrl)) {
        node.html = node.html.split(oldUrl).join(newUrl);
        changed = true;
      }
    }
  });

  return { lexical: JSON.stringify(doc), changed };
}

// ── extractMediaUrls ──────────────────────────────────────────────────────────
// Walk tree, collect all URLs from image/video src properties and
// htmlCard node.html img src attributes.
// Options: { unique: true } deduplicates results (for media pipeline).
// Default returns all occurrences (for URL scanning).
// Returns: string[]
function extractMediaUrls(lexicalJson, { unique = false } = {}) {
  let doc;
  try { doc = JSON.parse(lexicalJson); } catch { return []; }

  const urls = [];

  walkLexical(doc.root, (node) => {
    if ((node.type === 'image' || node.type === 'video') && node.src) {
      urls.push(node.src);
      return;
    }
    if (node.type === 'html' && typeof node.html === 'string') {
      // Extract src attributes from img tags in html cards
      const re = /<img[^>]+src=["']([^"']+)["']/gi;
      let m;
      while ((m = re.exec(node.html)) !== null) {
        urls.push(m[1]);
      }
    }
  });

  return unique ? [...new Set(urls)] : urls;
}

// ── patchVideoNodes ───────────────────────────────────────────────────────────
// Find video nodes by insertion order and update metadata fields.
// Extracted from the inline walk inside patchVideoNodes() in server.js.
//
// Inputs:
//   lexicalJson  – serialised Lexical string
//   videoDataArray – [{ src, thumbSrc, width, height, duration, mimeType, fileName }]
//
// Returns: always a serialised JSON string (patched or original on parse error)
function patchVideoNodes(lexicalJson, videoDataArray) {
  let doc;
  try { doc = JSON.parse(lexicalJson); } catch { return lexicalJson; }

  let idx = 0;

  walkLexical(doc.root, (node) => {
    if (node.type !== 'video' || idx >= videoDataArray.length) return;

    const data = videoDataArray[idx];
    idx++;

    if (data.src)      node.src          = data.src;
    if (data.thumbSrc) node.thumbnailSrc = data.thumbSrc;
    if (data.width)  {
      node.width           = data.width;
      node.thumbnailWidth  = data.width;
    }
    if (data.height) {
      node.height          = data.height;
      node.thumbnailHeight = data.height;
    }
    if (data.duration != null) node.duration = data.duration;
    if (data.loop     != null) node.loop     = data.loop;
    if (data.mimeType)         node.mimeType = data.mimeType;
    if (data.fileName)         node.fileName = data.fileName;
  });

  return JSON.stringify(doc);
}

// ── isCardNode ────────────────────────────────────────────────────────────────
// Inverted logic: any node that is NOT paragraph or heading is a protected card.
// Covers image, video, audio, gallery, bookmark, embed, html, signup, callout,
// toggle, button, and any future Ghost card types.
function isCardNode(node) {
  return !['paragraph', 'heading'].includes(node.type);
}

// ── textToParagraphNodes ──────────────────────────────────────────────────────
// Split text on double-newline; produce one Lexical paragraph node per segment.
// Empty segments are skipped. Plain text only — inherently XSS-safe.
function textToParagraphNodes(text) {
  return text.split(/\n\n+/).map(s => s.trim()).filter(Boolean).map(segment => ({
    type: 'paragraph', version: 1,
    direction: 'ltr', format: '', indent: 0,
    children: [{ type: 'text', version: 1, text: segment, format: 0 }],
  }));
}

// ── insertParagraphNodes ──────────────────────────────────────────────────────
// Insert intro/body/outro paragraph nodes into a Lexical JSON string.
// Never modifies existing card nodes (image, video, gallery, etc.).
// Positions: intro → prepend, body → after last card, outro → append.
// Returns updated JSON string.
function insertParagraphNodes(lexicalJson, { intro, body, outro }) {
  const lexical = JSON.parse(lexicalJson);
  const root = lexical.root;

  if (intro) root.children.unshift(...textToParagraphNodes(intro));

  let lastCardIdx = -1;
  root.children.forEach((n, i) => { if (isCardNode(n)) lastCardIdx = i; });
  const bodyIdx = lastCardIdx === -1 ? root.children.length : lastCardIdx + 1;
  if (body) root.children.splice(bodyIdx, 0, ...textToParagraphNodes(body));

  if (outro) root.children.push(...textToParagraphNodes(outro));

  return JSON.stringify(lexical);
}

// ── buildImageNode ────────────────────────────────────────────────────────────
// Build a Ghost Lexical image card node.
// src: Ghost content URL, e.g. /content/images/2026/03/photo.jpg
function buildImageNode(src, {
  alt = '', caption = '', cardWidth = 'regular', width = null, height = null
} = {}) {
  return { type: 'image', version: 1, src, width, height,
           cardWidth, alt, caption, href: '' };
}

// ── insertImageNode ───────────────────────────────────────────────────────────
// Insert an image node into a Lexical JSON string.
// position: 'end' | 'beginning' | 'after-first-image'
// 'after-first-image' falls back to 'end' if no image node exists.
// Throws if lexicalJson cannot be parsed.
function insertImageNode(lexicalJson, imageNode, position = 'end') {
  const doc  = JSON.parse(lexicalJson);
  const root = doc.root;
  if (position === 'beginning') {
    root.children.unshift(imageNode);
  } else if (position === 'after-first-image') {
    const idx = root.children.findIndex(n => n.type === 'image');
    root.children.splice(idx !== -1 ? idx + 1 : root.children.length, 0, imageNode);
  } else {
    root.children.push(imageNode); // 'end' (default)
  }
  return JSON.stringify(doc);
}

// ── buildGalleryNode ──────────────────────────────────────────────────────────
// Build a Ghost Lexical gallery card node.
// images: array of { src, fileName?, width?, height?, alt? }
// All images assigned row: 0 — Ghost auto-distributes into its default grid.
// fileName is derived from src basename if not provided.
function buildGalleryNode(images, caption = '') {
  return {
    type:    'gallery',
    version: 1,
    images:  images.map(img => ({
      fileName: img.fileName || img.src.split('/').pop(),
      src:      img.src,
      width:    img.width  || null,
      height:   img.height || null,
      alt:      img.alt    || '',
      row:      0,
    })),
    caption,
  };
}

// ── insertGalleryNode ─────────────────────────────────────────────────────────
// Insert a gallery node into a Lexical JSON string.
// position: 'end' | 'beginning'
// 'after-first-image' is intentionally NOT supported for galleries.
// Throws if lexicalJson cannot be parsed.
function insertGalleryNode(lexicalJson, galleryNode, position = 'end') {
  const doc  = JSON.parse(lexicalJson);
  const root = doc.root;
  if (position === 'beginning') {
    root.children.unshift(galleryNode);
  } else {
    root.children.push(galleryNode);
  }
  return JSON.stringify(doc);
}

module.exports = {
  walkLexical,
  replaceUrlInLexical,
  extractMediaUrls,
  patchVideoNodes,
  isCardNode,
  textToParagraphNodes,
  insertParagraphNodes,
  buildImageNode,
  insertImageNode,
  buildGalleryNode,
  insertGalleryNode,
  buildHtmlNode,
  insertHtmlNode,
  extractHtmlNodes,
};

// ── buildHtmlNode ─────────────────────────────────────────────────────────────
// Build a Ghost Lexical html card node from a raw HTML string.
function buildHtmlNode(html) {
  return { type: 'html', version: 1, html };
}

// ── insertHtmlNode ────────────────────────────────────────────────────────────
// Insert an html card node into a Lexical JSON string.
// position: 'end' | 'beginning'
// Throws if lexicalJson cannot be parsed.
function insertHtmlNode(lexicalJson, htmlNode, position = 'end') {
  const doc  = JSON.parse(lexicalJson);
  const root = doc.root;
  if (position === 'beginning') {
    root.children.unshift(htmlNode);
  } else {
    root.children.push(htmlNode);
  }
  return JSON.stringify(doc);
}

// ── extractHtmlNodes ──────────────────────────────────────────────────────────
// Extract all html card nodes from a Lexical JSON string.
// Returns [{ index, html }] for each html-type child of root.
function extractHtmlNodes(lexicalJson) {
  let doc;
  try {
    doc = JSON.parse(lexicalJson);
  } catch {
    return [];
  }
  const children = (doc.root && doc.root.children) || [];
  return children
    .map((node, index) => ({ index, node }))
    .filter(({ node }) => node.type === 'html')
    .map(({ index, node }) => ({ index, html: node.html || '' }));
}
