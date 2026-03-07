# Changelog

All notable changes to Ghost Media Manager are documented here.
Format based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Planned
- Custom Ghost Theme with gallery lightbox + share buttons

## [1.0.0] - 2026-03-07

### Added
- **Media Management**
  - Image browser with search, sort, and filter
  - Usage tracking — shows which posts use each image
  - Upload via Ghost Admin API with drag & drop
  - Rename image with automatic Lexical-safe post update
  - Delete image from filesystem
  - Image editor (crop, rotate, flip, annotate, draw)
  - Overwrite image in place (atomic write)
  - Bulk delete across all tabs with progress tracking
  - One-click Markdown / HTML copy for any file

- **Videos & Files**
  - Videos tab — browse and manage Ghost `content/media/`
  - Files tab — browse and manage Ghost `content/files/`
  - Drag & drop upload for Videos (MP4, MOV, WebM, audio)
  - Drag & drop upload for Files (PDF, DOCX, XLSX, ZIP, etc.)

- **Posts & AI**
  - Post management — browse all posts with tag and excerpt status
  - Make Landscape — convert portrait feature images to 16:9
  - AI excerpt generation (Anthropic Claude)
  - AI post improvement — excerpt, tags, SEO title, body feedback
  - AI post body rewrite — generate and insert new paragraphs
  - Create AI draft posts from mixed media (images, videos, PDFs)
  - AI tags constrained to existing Ghost tags
  - Rate limiting on all AI endpoints

- **Import & Migration**
  - WordPress XML import with full Gutenberg block conversion
  - Downloads and re-uploads all media to Ghost
  - Preserves original publish dates, tags, slugs, excerpts
  - Real-time progress via SSE stream

- **Integrations**
  - Immich photo library integration
  - Ghost publication language detection

- **Infrastructure**
  - Ghost Admin API key authentication
  - Docker image with multi-arch support (amd64 + arm64)
  - Health check endpoint for container orchestration
