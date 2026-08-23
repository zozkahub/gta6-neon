# GTA VI Neon — Railway Ready

Premium single-page media library with a private control area.

## Local
```bash
npm install
npm start
```
Open `http://localhost:3000`.

Private control: `Ctrl+Shift+9` or `/_c9`, code `1209` by default.

## Railway
Set these Variables:
- `NODE_ENV=production`
- `ACCESS_CODE=1209`
- `SESSION_SECRET=` a long random value
- `STORAGE_DIR=/app/storage`
- `ADMIN_ROUTE=/_c9`

Mount a Railway Volume at `/app/storage` so the library, uploaded videos, and generated thumbnails survive deploy/restart.

Health check: `/health`.

## Thumbnails
Local uploads generate a JPEG thumbnail from the exact 1.0-second frame in the browser and upload that thumbnail with the video. Remote URLs use a same-origin proxy and the public browser captures frame 1.0s when the source allows seek/capture.

## Security
- Private control files are blocked from direct static access.
- HttpOnly + SameSite session cookies; Secure is enabled in production.
- CSRF tokens on state-changing controls.
- Timing-safe access-code comparison.
- Login and mutation rate limits.
- SSRF protection with DNS/IP checks and redirect re-validation for remote media URLs.
- Security headers and HSTS in production.
- Persistent storage is separated from the public directory.
