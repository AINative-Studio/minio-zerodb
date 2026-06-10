# minio-zerodb

Drop-in MinIO replacement backed by ZeroDB cloud storage.

## Rules

- This package has ZERO runtime dependencies (uses native fetch + FormData)
- ES module (index.js) and CommonJS (index.cjs) entry points
- All methods mirror MinIO's API signatures exactly
- Auto-provisioning uses POST /api/v1/public/instant-db
- ZeroDB REST API docs: see docs/api/ZERODB_FILE_STORAGE_GUIDE.md in the core repo
- Never store credentials in code or tests
- Tests use mocked fetch — no real API calls in CI
