# Configuration

All configuration is done via environment variables.

## Required

| Variable | Description | Example |
|----------|-------------|---------|
| `GHOST_URL` | Your Ghost instance URL (no trailing slash) | `https://ghost.example.com` |
| `GHOST_ADMIN_API_KEY` | Ghost Admin API key (format: `id:secret`) | `64f1f...` |

## Filesystem Access (optional but recommended)

Enables: rename files, delete files, image editor, usage badges.

Without these, Ghost Media Manager works in read-only API mode
(upload and browse only).

| Variable | Description | Ghost Path | Example |
|----------|-------------|-----------|---------|
| `GHOST_MEDIA_PATH` | Path to Ghost images directory | `content/images/` | `/ghost-content/images` |
| `GHOST_MEDIA_VIDEO_PATH` | Path to Ghost media directory | `content/media/` | `/ghost-content/media` |
| `GHOST_MEDIA_FILES_PATH` | Path to Ghost files directory | `content/files/` | `/ghost-content/files` |

### Docker volume example

```yaml
volumes:
  - /path/to/ghost/content/images:/ghost-images
  - /path/to/ghost/content/media:/ghost-media
  - /path/to/ghost/content/files:/ghost-files
environment:
  - GHOST_MEDIA_PATH=/ghost-images
  - GHOST_MEDIA_VIDEO_PATH=/ghost-media
  - GHOST_MEDIA_FILES_PATH=/ghost-files
```

## AI Features (optional)

Enables: AI excerpt generation, post improvement, create post from images.
Requires an Anthropic API account (https://console.anthropic.com).

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key | — |
| `AI_MODEL_TEXT` | Model for text tasks (excerpts, tags, SEO) | `claude-haiku-4-5-20251001` |
| `AI_MODEL_VISION` | Model for vision tasks (create post from images) | `claude-opus-4-6` |
| `AI_MODEL_CONTENT` | Model for long-form content generation | falls back to `AI_MODEL_TEXT` |

Estimated costs: ~$0.06 for 50 excerpts, ~$0.05 per image post.

## Immich Integration (optional)

Enables: browse Immich library and import photos directly to Ghost.

| Variable | Description | Example |
|----------|-------------|---------|
| `IMMICH_URL` | Immich instance URL | `https://immich.example.com` |
| `IMMICH_API_KEY` | Immich API key | `abc123...` |

## Server

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP port to listen on | `3334` |
| `NODE_ENV` | Set to `production` to suppress stack traces in logs | `development` |
