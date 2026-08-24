# GTA VI Neon Media Library

Node/Express media library with a protected control panel, paginated browsing, dedicated media pages, queued first-second thumbnails, and optional Postgres persistence.

## Render persistence

Set `DATABASE_URL` to a Render Postgres connection string for persistent metadata and thumbnails. Without it, the app falls back to `storage/videos.json`, which is not durable on Render Free.

Useful variables:

- `NODE_ENV=production`
- `ACCESS_CODE=1209`
- `ADMIN_ROUTE=/_c9`
- `STORAGE_DIR=/tmp/storage` for temporary local files, or a persistent disk path on a paid Render service
- `DATABASE_URL=<Render Postgres URL>`

The public library only loads a small page of poster cards at a time. Opening an item navigates to `/video/<id>` so only one video player exists on that page.

The private control panel accepts unlimited lines (validated server-side, max 100 per batch) in the format:

`video-url - title - description`

Each row can be edited after parsing. The save queue inserts metadata first, then generates and stores a frame near the first second with only two thumbnail jobs running concurrently to avoid browser/server stalls.
