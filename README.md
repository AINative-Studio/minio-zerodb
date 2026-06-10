# minio-zerodb

Drop-in MinIO replacement pre-configured for ZeroDB cloud storage. Zero config — auto-provisions free storage on first use.

## Why?

MinIO is great, but you need to run a server. `minio-zerodb` gives you the same API backed by ZeroDB's managed cloud storage. No server, no config, no signup — just `npm install` and go.

## Install

```bash
npm install minio-zerodb
```

## Quick Start

```javascript
import { ZeroDBStorage } from 'minio-zerodb';

const storage = new ZeroDBStorage();

// Upload a file
await storage.uploadFile('hello.txt', Buffer.from('Hello, World!'));

// Download it
const stream = await storage.downloadFile('hello.txt');

// Get a shareable URL (1 hour)
const url = await storage.getUrl('hello.txt');

// List all files
const files = await storage.listFiles();
```

That's it. On first use, a free ZeroDB project is auto-provisioned. You'll see a claim URL in the console to keep it permanently.

## MinIO-Compatible API

Every standard MinIO method works:

```javascript
const storage = new ZeroDBStorage();

// putObject / getObject / removeObject
await storage.putObject('my-bucket', 'docs/report.pdf', pdfBuffer);
const stream = await storage.getObject('my-bucket', 'docs/report.pdf');
await storage.removeObject('my-bucket', 'docs/report.pdf');

// presignedGetObject
const url = await storage.presignedGetObject('my-bucket', 'docs/report.pdf', 7200);

// listObjects (EventEmitter pattern)
const objects = storage.listObjects('my-bucket', 'docs/');
objects.on('data', (obj) => console.log(obj.name, obj.size));
objects.on('end', () => console.log('Done'));

// statObject
const stat = await storage.statObject('my-bucket', 'docs/report.pdf');
console.log(stat.size, stat.contentType);

// Bucket operations (no-op in ZeroDB, always succeeds)
await storage.makeBucket('my-bucket');
const exists = await storage.bucketExists('my-bucket'); // true
const buckets = await storage.listBuckets();
```

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ZERODB_API_KEY` | ZeroDB API key (also accepts `MINIO_ACCESS_KEY`) |
| `ZERODB_PROJECT_ID` | ZeroDB project ID |
| `ZERODB_ENDPOINT` | Custom API endpoint (default: `https://api.ainative.studio`) |

### Constructor Options

```javascript
const storage = new ZeroDBStorage({
  accessKey: 'your-api-key',      // or set ZERODB_API_KEY
  projectId: 'your-project-id',   // or set ZERODB_PROJECT_ID
  bucket: 'default',              // default bucket name
  endPoint: 'api.ainative.studio', // API endpoint
  port: 443,                      // ignored (always HTTPS)
  useSSL: true,                   // ignored (always HTTPS)
});
```

If no credentials are provided, a free project is auto-provisioned on first API call.

## Convenience Methods

Beyond the MinIO API, these helpers simplify common operations:

| Method | Description |
|--------|-------------|
| `uploadFile(name, data, metadata?)` | Upload with simple name + buffer |
| `downloadFile(name)` | Download by name, returns stream |
| `listFiles(prefix?)` | List files with metadata |
| `getUrl(name, expiry?)` | Get presigned download URL |
| `deleteFile(name)` | Delete by name |
| `getStats()` | Project storage statistics |

## CommonJS

```javascript
const { ZeroDBStorage } = require('minio-zerodb');
const storage = new ZeroDBStorage();
```

## How It Works

Under the hood, `minio-zerodb` wraps ZeroDB's REST file storage API with a MinIO-compatible interface. Files are stored in MinIO-backed object storage on ZeroDB's infrastructure with automatic metadata tracking.

**Architecture:**
- Upload: `PUT` maps to `POST /database/storage/upload`
- Download: `GET` maps to presigned URL flow via `GET /database/files/{id}/download`
- List: maps to `GET /database/files`
- Delete: maps to `DELETE /database/files/{id}`

## Free Tier

Auto-provisioned projects include:
- 350MB max file size
- 72-hour trial (claim to keep permanently)
- Unlimited files within storage quota
- Presigned URLs with configurable expiry

## License

MIT
