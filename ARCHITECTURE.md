# Architecture

## Tech Stack

- **Backend:** Node.js + Express
- **Frontend:** Vanilla JavaScript (no framework)
- **Ghost API:** Ghost Admin API v5
- **AI:** Anthropic Claude API
- **Image editor:** Filerobot Image Editor (Fabric.js + Cropper.js)
- **Container:** Docker (multi-arch: amd64 + arm64)

## Project Structure

```
ghost-media-manager/
├── server.js                  ← Express app, all routes
├── server/lib/
│   ├── lexical.js             ← ALL Lexical JSON operations
│   ├── ghost.js               ← ALL Ghost Admin API calls
│   ├── filesystem.js          ← Filesystem walk + path validation
│   └── imageProcessing.js     ← Portrait-to-landscape conversion
├── public/
│   ├── index.html             ← UI (single page)
│   └── app.js                 ← All frontend logic
└── Dockerfile
```

## Backend Routes

### Media (images)
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/media` | List all images from filesystem |
| POST | `/api/media/upload` | Upload image to Ghost |
| DELETE | `/api/media/file` | Delete image from filesystem |
| POST | `/api/media/rename` | Rename image + update all posts |
| POST | `/api/media/overwrite` | Replace image file (atomic) |
| GET | `/api/media/proxy` | Proxy image for editor |

### Videos
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/videos` | List all videos from filesystem |
| POST | `/api/videos/upload` | Upload video/audio to Ghost |
| GET | `/api/videos/thumbnail` | Generate video thumbnail (ffmpeg) |
| DELETE | `/api/videos/file` | Delete video from filesystem |
| POST | `/api/videos/rename` | Rename video + update all posts |

### Files
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/files` | List all files from filesystem |
| POST | `/api/files/upload` | Upload file attachment to Ghost |
| GET | `/api/files/download` | Download file via proxy |
| DELETE | `/api/files/file` | Delete file from filesystem |
| POST | `/api/files/rename` | Rename file + update all posts |

### Posts
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/posts` | List posts with tags |
| GET | `/api/posts/all` | All posts with full content (for usage scanning) |
| GET | `/api/posts/:type/:id` | Single post with full content |
| POST | `/api/posts/create` | Create new post |
| POST | `/api/posts/:id/make-landscape` | Convert portrait feature image to 16:9 landscape |

### Tags
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/tags/all` | List all tags (paginated via ghostFetchAll) |
| PUT | `/api/tags/:id` | Update a tag |

### AI
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/ai/excerpt` | Generate excerpt for one post |
| POST | `/api/ai/improve` | Improve post (excerpt/tags/SEO/content) |
| POST | `/api/ai/apply-body` | Apply AI-generated body content to post |
| POST | `/api/ai/create-from-images` | Create post from mixed media (images/videos/PDFs) |

**AI tag constraint:** All AI endpoints that suggest or assign tags (`/api/ai/improve`, `/api/ai/create-from-images`) fetch the full tag list via `ghostFetchAll` before calling the AI, include it in the prompt, and filter the AI response server-side. Tags not present in Ghost are silently removed. This prevents the Ghost Admin API from auto-creating unintended tags that could break navigation or routes.

### Immich
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/immich/albums` | List Immich albums |
| GET | `/api/immich/assets` | List assets in album |
| POST | `/api/immich/import` | Import Immich asset to Ghost |

### Tools
| Method | Route | Description |
|--------|-------|-------------|
| POST | `/api/tools/parse-wordpress-xml` | Parse WP XML, return preview |
| POST | `/api/tools/import-wordpress` | Full WP import (SSE stream) |
| GET | `/api/tools/import-wordpress-log/:token` | Download import log |

### HTML Editor
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/posts/:type/:id/html-cards` | Extract all HTML card nodes from a post's Lexical JSON |

### Ghost
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/ghost/lang` | Get Ghost publication language |

### Config
| Method | Route | Description |
|--------|-------|-------------|
| GET | `/api/config` | Returns Ghost URL + feature flags |
| GET | `/api/health` | Health check endpoint |

## Critical Rules

### HTML Live Editor

The HTML Live Editor tab is a split-pane workbench for Ghost HTML cards.
Editor state (CodeMirror instance + current HTML value) is local to `initHtmlEditorTab()` in `app.js`.
It reads from shared `state` caches (`state.allImages`, `state.postsData`) for media and post pickers,
but does not own or mutate those caches.

Key implementation details:
- **CodeMirror 5** via CDN (`cdnjs.cloudflare.com`) — htmlmixed mode, Dracula theme
  ⚠ **Supply-chain note:** the CDN script runs without Subresource Integrity (SRI).
  Future hardening: bundle CodeMirror locally or add `integrity=` + `crossorigin=anonymous` to the `<script>` tags.
- `viewportMargin: Infinity` + wrapper scroll (not CM internal scroll)
- `extractHtmlNodes(lexicalJson)` in `server/lib/lexical.js` — used by the Load HTML Card route
- CSP: `cdnjs.cloudflare.com` is whitelisted in `scriptSrc` and `styleSrc`
- Load HTML Card modal fetches `GET /api/posts/:type/:id/html-cards`; clicking a card calls `cm.setValue(card.html)`
- Insert into Post calls `POST /api/media/insert-into-post` with `mode: 'html'` (appends an HTML card node via `insertHtmlNode`)

---

### Lexical JSON (CRITICAL — read before touching posts)

Ghost stores post content as Lexical JSON in the `lexical` field.
ALL operations on Lexical content must use `server/lib/lexical.js`.

Rules that must NEVER be violated:
- NEVER do string replace on raw serialized Lexical JSON
- NEVER touch the top-level `html` field
- `image` nodes: exact match on `node.src` only
- `video` nodes: exact match on `node.src` only
- `htmlCard` nodes: `replaceAll` within `node.html` only
- Always parse → modify → serialize (never regex on the string)
- Always include `updated_at` in every PUT request

### Authentication

All protected routes use `requireGhostAuth` middleware.
API key is passed via `Authorization: Bearer <key>` header.
Validated keys are cached for 60 seconds to avoid repeated
Ghost API roundtrips.

### Filesystem Security

All filesystem operations use `resolveContentPath()` from
`server/lib/filesystem.js`. This prevents path traversal attacks.
Never resolve user-supplied paths manually in route handlers.

### Caching

- **Auth cache:** 60s TTL, keyed by API key
- **Filesystem listings:** 30s TTL, keyed by content type
- Invalidated automatically on upload/delete/rename operations

## State Management (Frontend)

All frontend state lives in the `state` object in app.js:

```javascript
const state = {
  apiKey:        null,    // Ghost Admin API key
  allImages:     [],      // loaded image list
  allVideos:     [],      // loaded video list
  allFiles:      [],      // loaded file list
  postsCache:    null,    // all posts (for usage badges)
  ghostLang:     'en',    // publication language (from Ghost settings)
  aiAvailable:   false,   // true when ANTHROPIC_API_KEY is configured
  selectedImages: [],     // selected image URLs (Select Mode)
  selectedVideos: [],     // selected video URLs (Select Mode)
  selectedFiles:  [],     // selected file URLs (Select Mode)
  // ... modal targets, flags
}
```

The HTML Live Editor tab manages its own **editor state** locally inside
`initHtmlEditorTab()`: the CodeMirror instance (`cm`) and the current
HTML value are not stored on the global `state` object.

It **does** read from shared caches on `state` (for example
`state.allImages` and `state.postsData`/`postsCache`) when opening media
or post pickers/modals, but those caches are owned and maintained by the
global `state` layer, not by the HTML Live Editor itself.

```javascript
// HTML Editor local state (inside initHtmlEditorTab)
const cm = CodeMirror(cmHost, { mode: 'htmlmixed', theme: 'dracula', ... });
// All operations: cm.getValue(), cm.setValue(), cm.replaceRange()
```
