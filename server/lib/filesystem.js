'use strict';

// ── server/lib/filesystem.js ──────────────────────────────────────────────────
// Filesystem helpers for Ghost content mounts (images / media / files).
//
// Exports:
//   walkContentDir(rootDir, urlPrefix, opts)  — generic recursive dir walker
//   resolveContentPath(url, contentMarker, rootDir)  — URL → {absPath, relPath}
//   urlToContentPath(url, contentType)               — convenience wrapper
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs   = require('fs').promises;

// Env-based root paths — read once at module load, same as server.js top-level consts.
const GHOST_MEDIA_PATH       = process.env.GHOST_MEDIA_PATH        || '/ghost-content/images';
const GHOST_MEDIA_VIDEO_PATH = process.env.GHOST_MEDIA_VIDEO_PATH  || '/ghost-content/media';
const GHOST_MEDIA_FILES_PATH = process.env.GHOST_MEDIA_FILES_PATH  || '/ghost-content/files';

// ── walkContentDir ────────────────────────────────────────────────────────────
// Generic recursive directory walker. Replaces walkMediaDir, walkVideoDir,
// walkFilesDir (~50 lines saved, D2).
//
// @param {string}   rootDir     - absolute path to the root directory
// @param {string}   urlPrefix   - e.g. `${GHOST_URL}/content/images`
// @param {object}   opts
// @param {string[]} [opts.skipDirs]   - relative paths of directories to skip
//                                       entirely (matched against full rel path,
//                                       so 'size' skips only the top-level dir)
// @param {Set|null} [opts.extFilter]  - Set of lowercase extensions (incl. dot);
//                                       null or omitted = accept all extensions
// @param {function|null} [opts.skipFile] - (entry) => bool; true = skip this file
// @param {function} opts.buildEntry   - async (entry, rel, stat, dir, urlPrefix)
//                                       => object|null. Return null to skip entry.
// @returns {Promise<object[]>}
async function walkContentDir(rootDir, urlPrefix, opts = {}) {
  const { skipDirs = [], extFilter = null, skipFile = null, buildEntry } = opts;
  if (!buildEntry) throw new Error('walkContentDir: opts.buildEntry is required');

  const results = [];

  async function walk(dir, base) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); }
    catch { return; } // directory unreadable — skip silently

    for (const entry of entries) {
      const rel = base ? `${base}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // Note: skipDirs matches against the full relative path from rootDir.
        // 'size' skips only /rootDir/size/, not /rootDir/year/size/ subdirectories.
        if (skipDirs.includes(rel)) continue;
        await walk(path.join(dir, entry.name), rel);
      } else {
        if (extFilter && !extFilter.has(path.extname(entry.name).toLowerCase())) continue;
        if (skipFile && skipFile(entry)) continue;

        try {
          const stat = await fs.stat(path.join(dir, entry.name));
          const built = await buildEntry(entry, rel, stat, dir, urlPrefix);
          if (built !== null && built !== undefined) results.push(built);
        } catch { /* skip unreadable files */ }
      }
    }
  }

  await walk(rootDir, '');
  return results;
}

// ── resolveContentPath ────────────────────────────────────────────────────────
// Extracts the relative path from a Ghost content URL, validates it against
// rootDir to prevent directory traversal, and returns { absPath, relPath }.
//
// Replaces ~8 inline path-validation blocks across video/files routes (D3).
//
// @param {string} url           - the full Ghost content URL
// @param {string} contentMarker - e.g. '/content/images/', '/content/media/'
// @param {string} rootDir       - absolute filesystem root for this content type
// @returns {{ absPath: string, relPath: string }}
// @throws {Error} if URL is missing the marker, or path traversal is detected
function resolveContentPath(url, contentMarker, rootDir) {
  const idx = url.indexOf(contentMarker);
  if (idx === -1) throw new Error(`URL does not contain "${contentMarker}"`);

  const rel        = url.slice(idx + contentMarker.length).split('?')[0];
  const normalized = path.normalize(rel);

  // Quick pre-check before computing absolute paths
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error('Path traversal detected');
  }

  const absRoot = path.resolve(rootDir);
  const absPath = path.resolve(path.join(rootDir, normalized));

  // Containment check: resolved path must be strictly inside absRoot
  if (absPath !== absRoot && !absPath.startsWith(absRoot + path.sep)) {
    throw new Error('Path traversal detected');
  }

  // relPath always uses forward slashes regardless of OS
  const relPath = path.relative(absRoot, absPath).replace(/\\/g, '/');
  return { absPath, relPath };
}

// ── urlToContentPath ──────────────────────────────────────────────────────────
// Maps a Ghost content URL to an absolute filesystem path + relative path.
// Convenience wrapper around resolveContentPath for the three known content types.
// Replaces urlToFilePath() and the duplicated inline URL→path blocks (R2).
//
// @param {string} url         - full Ghost content URL
// @param {string} contentType - 'images' | 'media' | 'files'
// @returns {{ absPath: string, relPath: string }}
// @throws {Error} on unknown contentType, invalid URL, or path traversal
function urlToContentPath(url, contentType) {
  const map = {
    images: { marker: '/content/images/', rootDir: GHOST_MEDIA_PATH       },
    media:  { marker: '/content/media/',  rootDir: GHOST_MEDIA_VIDEO_PATH  },
    files:  { marker: '/content/files/',  rootDir: GHOST_MEDIA_FILES_PATH  },
  };

  const entry = map[contentType];
  if (!entry) throw new Error(`urlToContentPath: unknown contentType "${contentType}"`);

  return resolveContentPath(url, entry.marker, entry.rootDir);
}

module.exports = { walkContentDir, resolveContentPath, urlToContentPath };
