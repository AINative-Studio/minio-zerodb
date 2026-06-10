# minio-zerodb — Cody Context

## What This Package Does

MinIO-compatible API wrapper over ZeroDB's REST file storage. Users do
`npm install minio-zerodb` instead of `minio` and get managed cloud storage
with zero configuration.

## Key Design Decisions

1. **No minio dependency** — we implement the MinIO Client interface directly
   over ZeroDB REST API rather than extending minio.Client, because ZeroDB
   doesn't expose raw S3 protocol.

2. **Auto-provisioning** — if no API key is set, we call instant-db to get one.

3. **Bucket is logical** — ZeroDB uses one MinIO bucket per project internally,
   so bucket names are mapped to key prefixes.

## Files

- `index.js` — ES module entry
- `index.cjs` — CommonJS entry
- `tests/basic.test.js` — Unit tests with mocked fetch
