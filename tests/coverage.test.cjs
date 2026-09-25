/**
 * minio-zerodb comprehensive coverage tests.
 * Uses Node.js native test runner — run with: npx c8 node --test tests/coverage.test.cjs
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { ZeroDBStorage, Client } = require('../index.cjs');

// ---------------------------------------------------------------------------
// Mock fetch infrastructure
// ---------------------------------------------------------------------------

const mockResponses = [];

function pushMock(status, body, contentType = 'application/json') {
  mockResponses.push({ status, body, contentType });
}

function createMockFetch() {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const mock = mockResponses.shift();
    if (!mock) throw new Error(`Unexpected fetch call: ${url}`);

    return {
      ok: mock.status >= 200 && mock.status < 300,
      status: mock.status,
      headers: {
        get: (name) => {
          if (name === 'content-type') return mock.contentType;
          return null;
        },
      },
      json: async () => (typeof mock.body === 'string' ? JSON.parse(mock.body) : mock.body),
      text: async () => (typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body)),
      arrayBuffer: async () => {
        const str = typeof mock.body === 'string' ? mock.body : JSON.stringify(mock.body);
        return Buffer.from(str).buffer;
      },
      body: null,
    };
  };
  fn.calls = calls;
  return fn;
}

let mockFetch;

beforeEach(() => {
  mockResponses.length = 0;
  mockFetch = createMockFetch();
  globalThis.fetch = mockFetch;
});

afterEach(() => {
  delete globalThis.fetch;
  delete process.env.ZERODB_API_KEY;
  delete process.env.ZERODB_PROJECT_ID;
  delete process.env.ZERODB_ENDPOINT;
  delete process.env.MINIO_ACCESS_KEY;
});

// ---------------------------------------------------------------------------
// Constructor — all credential resolution paths
// ---------------------------------------------------------------------------

describe('ZeroDBStorage constructor', () => {
  it('uses provided accessKey and projectId', () => {
    const s = new ZeroDBStorage({ accessKey: 'ak', projectId: 'pid' });
    assert.equal(s._apiKey, 'ak');
    assert.equal(s._projectId, 'pid');
    assert.equal(s.accessKey, 'ak');
  });

  it('uses secretKey as fallback when no accessKey', () => {
    const s = new ZeroDBStorage({ secretKey: 'sk', projectId: 'pid' });
    assert.equal(s._apiKey, 'sk');
    assert.equal(s.secretKey, 'sk');
  });

  it('reads ZERODB_API_KEY from env', () => {
    process.env.ZERODB_API_KEY = 'env-key';
    const s = new ZeroDBStorage();
    assert.equal(s._apiKey, 'env-key');
  });

  it('reads ZERODB_PROJECT_ID from env', () => {
    process.env.ZERODB_PROJECT_ID = 'env-proj';
    process.env.ZERODB_API_KEY = 'k';
    const s = new ZeroDBStorage();
    assert.equal(s._projectId, 'env-proj');
  });

  it('reads MINIO_ACCESS_KEY from env as last fallback', () => {
    process.env.MINIO_ACCESS_KEY = 'minio-key';
    const s = new ZeroDBStorage();
    assert.equal(s._apiKey, 'minio-key');
  });

  it('reads ZERODB_ENDPOINT from env', () => {
    process.env.ZERODB_ENDPOINT = 'https://custom.api.com';
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    assert.equal(s._endPoint, 'https://custom.api.com');
  });

  it('uses opts.endPoint over env', () => {
    process.env.ZERODB_ENDPOINT = 'https://env.api.com';
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p', endPoint: 'https://opts.api.com' });
    assert.equal(s._endPoint, 'https://opts.api.com');
    assert.equal(s.endPoint, 'https://opts.api.com');
  });

  it('defaults endPoint to api.ainative.studio', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    assert.equal(s.endPoint, 'api.ainative.studio');
  });

  it('defaults port to 443', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    assert.equal(s.port, 443);
  });

  it('accepts custom port', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p', port: 9000 });
    assert.equal(s.port, 9000);
  });

  it('defaults useSSL to true', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    assert.equal(s.useSSL, true);
  });

  it('allows useSSL=false', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p', useSSL: false });
    assert.equal(s.useSSL, false);
  });

  it('defaults bucket to "default"', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    assert.equal(s._defaultBucket, 'default');
  });

  it('accepts custom bucket', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p', bucket: 'photos' });
    assert.equal(s._defaultBucket, 'photos');
  });

  it('initializes _provisioned=false and _provisionPromise=null', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    assert.equal(s._provisioned, false);
    assert.equal(s._provisionPromise, null);
  });

  it('empty string apiKey / projectId when no creds at all', () => {
    const s = new ZeroDBStorage();
    assert.equal(s._apiKey, '');
    assert.equal(s._projectId, '');
  });
});

// ---------------------------------------------------------------------------
// Client export alias
// ---------------------------------------------------------------------------

describe('Client export', () => {
  it('Client === ZeroDBStorage', () => {
    assert.equal(Client, ZeroDBStorage);
  });
});

// ---------------------------------------------------------------------------
// _headers and _storageUrl internals
// ---------------------------------------------------------------------------

describe('internal helpers', () => {
  it('_headers returns X-API-Key header', () => {
    const s = new ZeroDBStorage({ accessKey: 'my-key', projectId: 'p' });
    assert.deepEqual(s._headers(), { 'X-API-Key': 'my-key' });
  });

  it('_storageUrl builds correct URL', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'proj-123' });
    assert.match(s._storageUrl(), /\/v1\/zerodb\/proj-123\/database$/);
  });

  it('_storageUrl uses custom endpoint', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p', endPoint: 'https://custom.com' });
    assert.equal(s._storageUrl(), 'https://custom.com/v1/zerodb/p/database');
  });
});

// ---------------------------------------------------------------------------
// Auto-provisioning
// ---------------------------------------------------------------------------

describe('auto-provisioning', () => {
  it('provisions when no credentials and sets fields', async () => {
    pushMock(200, {
      project_id: 'auto-proj',
      api_key: 'auto-key',
      claim_url: 'https://example.test/claim/abc',
    });

    const s = new ZeroDBStorage();
    await s.listBuckets(); // triggers _ensureProvisioned

    assert.equal(s._projectId, 'auto-proj');
    assert.equal(s._apiKey, 'auto-key');
    assert.equal(s.accessKey, 'auto-key');
    assert.equal(s.secretKey, 'auto-key');
    assert.equal(s._provisioned, true);
  });

  it('skips provisioning when credentials present', async () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.listBuckets();
    assert.equal(mockFetch.calls.length, 0);
  });

  it('deduplicates concurrent provisioning calls', async () => {
    pushMock(200, { project_id: 'p1', api_key: 'k1', claim_url: null });

    const s = new ZeroDBStorage();
    // Call _ensureProvisioned twice concurrently
    await Promise.all([s._ensureProvisioned(), s._ensureProvisioned()]);
    // Only 1 fetch call for provisioning
    assert.equal(mockFetch.calls.length, 1);
  });

  it('logs claim URL when present', async () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    pushMock(200, {
      project_id: 'p1',
      api_key: 'k1',
      claim_url: 'https://example.test/claim/xyz',
    });

    const s = new ZeroDBStorage();
    await s._ensureProvisioned();

    console.log = origLog;
    const allOutput = logs.join('\n');
    assert.ok(allOutput.includes('auto-provisioned'));
    assert.ok(allOutput.includes('https://example.test/claim/xyz'));
  });

  it('does not log when no claim URL', async () => {
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => logs.push(args.join(' '));

    pushMock(200, { project_id: 'p1', api_key: 'k1', claim_url: null });

    const s = new ZeroDBStorage();
    await s._ensureProvisioned();

    console.log = origLog;
    assert.equal(logs.length, 0);
  });

  it('throws on provisioning failure (e.g. 500)', async () => {
    pushMock(500, 'Internal Server Error');

    const s = new ZeroDBStorage();
    await assert.rejects(
      () => s._ensureProvisioned(),
      (err) => {
        assert.match(err.message, /ZeroDB API error 500/);
        assert.equal(err.statusCode, 500);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// putObject
// ---------------------------------------------------------------------------

describe('putObject', () => {
  it('uploads a Buffer to default bucket', async () => {
    pushMock(200, { success: true, file_id: 'f1', file_key: 'test.txt' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const result = await s.putObject('default', 'test.txt', Buffer.from('hello'));

    assert.equal(result.etag, 'f1');
    assert.equal(result.versionId, null);
    assert.equal(mockFetch.calls.length, 1);
    assert.ok(mockFetch.calls[0].url.includes('/storage/upload'));
  });

  it('uploads a string', async () => {
    pushMock(200, { file_id: 'f2' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const result = await s.putObject('default', 'note.txt', 'hello world');

    assert.equal(result.etag, 'f2');
  });

  it('uploads with metadata', async () => {
    pushMock(200, { file_id: 'f3' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.putObject('default', 'doc.txt', 'data', undefined, { tag: 'important' });

    assert.equal(mockFetch.calls.length, 1);
  });

  it('uses bucket prefix for non-default bucket', async () => {
    pushMock(200, { file_id: 'f4' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.putObject('my-bucket', 'file.txt', Buffer.from('x'));

    assert.equal(mockFetch.calls.length, 1);
  });

  it('handles async iterable (stream-like) data', async () => {
    pushMock(200, { file_id: 'f5' });

    const asyncIter = {
      [Symbol.asyncIterator]() {
        let done = false;
        return {
          async next() {
            if (done) return { done: true };
            done = true;
            return { value: Buffer.from('chunk'), done: false };
          },
        };
      },
    };

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const result = await s.putObject('default', 'stream.bin', asyncIter);
    assert.equal(result.etag, 'f5');
  });

  it('handles generic data (Blob fallback)', async () => {
    pushMock(200, { file_id: 'f6' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const result = await s.putObject('default', 'data.bin', new Uint8Array([1, 2, 3]));
    assert.equal(result.etag, 'f6');
  });

  it('returns empty etag when file_id missing from response', async () => {
    pushMock(200, { success: true });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const result = await s.putObject('default', 'empty.txt', 'x');
    assert.equal(result.etag, '');
  });
});

// ---------------------------------------------------------------------------
// getObject
// ---------------------------------------------------------------------------

describe('getObject', () => {
  it('downloads file as readable stream', async () => {
    // Mock _findFileId => list files
    pushMock(200, [{ file_id: 'dl-1', file_key: 'data.txt', size_bytes: 5 }]);
    // Mock download info
    pushMock(200, { download_url: 'https://cdn.example.test/dl/data.txt' });
    // Mock actual download
    pushMock(200, 'hello', 'text/plain');

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const stream = await s.getObject('default', 'data.txt');

    // Should be a readable stream
    assert.ok(stream);
    assert.ok(typeof stream.read === 'function' || typeof stream.pipe === 'function');
  });

  it('throws NoSuchKey when file not found', async () => {
    pushMock(200, []);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await assert.rejects(
      () => s.getObject('default', 'missing.txt'),
      (err) => {
        assert.equal(err.code, 'NoSuchKey');
        assert.match(err.message, /Object not found/);
        return true;
      }
    );
  });

  it('throws when download HTTP request fails', async () => {
    pushMock(200, [{ file_id: 'dl-2', file_key: 'bad.txt' }]);
    pushMock(200, { download_url: 'https://cdn.example.test/dl/bad.txt' });
    pushMock(404, 'Not Found', 'text/plain');

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await assert.rejects(
      () => s.getObject('default', 'bad.txt'),
      (err) => {
        assert.match(err.message, /Download failed: 404/);
        return true;
      }
    );
  });

  it('handles non-default bucket key prefix', async () => {
    pushMock(200, [{ file_id: 'dl-3', file_key: 'photos/pic.jpg' }]);
    pushMock(200, { download_url: 'https://cdn.example.test/dl/pic.jpg' });
    pushMock(200, 'imgdata', 'image/jpeg');

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const stream = await s.getObject('photos', 'pic.jpg');
    assert.ok(stream);
  });
});

// ---------------------------------------------------------------------------
// downloadFile convenience
// ---------------------------------------------------------------------------

describe('downloadFile', () => {
  it('delegates to getObject with default bucket', async () => {
    pushMock(200, [{ file_id: 'dl-c', file_key: 'doc.pdf' }]);
    pushMock(200, { download_url: 'https://cdn.example.test/dl/doc.pdf' });
    pushMock(200, 'pdfcontent', 'application/pdf');

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const stream = await s.downloadFile('doc.pdf');
    assert.ok(stream);
  });
});

// ---------------------------------------------------------------------------
// presignedGetObject
// ---------------------------------------------------------------------------

describe('presignedGetObject', () => {
  it('returns presigned_url', async () => {
    pushMock(200, [{ file_id: 'ps-1', file_key: 'secret.txt' }]);
    pushMock(200, { presigned_url: 'https://cdn.example.test/presigned/secret.txt?token=abc' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const url = await s.presignedGetObject('default', 'secret.txt', 7200);

    assert.equal(url, 'https://cdn.example.test/presigned/secret.txt?token=abc');
  });

  it('falls back to result.url when presigned_url missing', async () => {
    pushMock(200, [{ file_id: 'ps-2', file_key: 'alt.txt' }]);
    pushMock(200, { url: 'https://cdn.example.test/url/alt.txt' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const url = await s.presignedGetObject('default', 'alt.txt');

    assert.equal(url, 'https://cdn.example.test/url/alt.txt');
  });

  it('throws NoSuchKey when file not found', async () => {
    pushMock(200, []);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await assert.rejects(
      () => s.presignedGetObject('default', 'nope.txt'),
      (err) => {
        assert.equal(err.code, 'NoSuchKey');
        return true;
      }
    );
  });

  it('uses default expiry of 3600', async () => {
    pushMock(200, [{ file_id: 'ps-3', file_key: 'def.txt' }]);
    pushMock(200, { presigned_url: 'https://example.com' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.presignedGetObject('default', 'def.txt');

    const body = JSON.parse(mockFetch.calls[1].opts.body);
    assert.equal(body.expiration, 3600);
    assert.equal(body.operation, 'download');
  });
});

// ---------------------------------------------------------------------------
// getUrl convenience
// ---------------------------------------------------------------------------

describe('getUrl', () => {
  it('delegates to presignedGetObject with default bucket', async () => {
    pushMock(200, [{ file_id: 'gu-1', file_key: 'file.txt' }]);
    pushMock(200, { presigned_url: 'https://cdn.example.test/u' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const url = await s.getUrl('file.txt', 600);
    assert.equal(url, 'https://cdn.example.test/u');
  });
});

// ---------------------------------------------------------------------------
// listObjects (EventEmitter pattern)
// ---------------------------------------------------------------------------

describe('listObjects', () => {
  it('emits data and end events', async () => {
    pushMock(200, [
      { file_id: 'f1', file_key: 'a.txt', file_name: 'a.txt', size_bytes: 10, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' },
      { file_id: 'f2', file_key: 'b.txt', file_name: 'b.txt', size_bytes: 20, created_at: '2026-01-01T00:00:00Z' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const objects = [];

    await new Promise((resolve, reject) => {
      s.listObjects('default')
        .on('data', (obj) => objects.push(obj))
        .on('end', resolve)
        .on('error', reject);
    });

    assert.equal(objects.length, 2);
    assert.equal(objects[0].name, 'a.txt');
    assert.equal(objects[0].size, 10);
    assert.equal(objects[0].etag, 'f1');
    assert.ok(objects[0].lastModified instanceof Date);
    assert.equal(objects[0].prefix, '');
    assert.equal(objects[1].size, 20);
  });

  it('filters by prefix in default bucket', async () => {
    pushMock(200, [
      { file_id: 'f1', file_key: 'docs/a.txt', file_name: 'a.txt', size_bytes: 1, created_at: '2026-01-01T00:00:00Z' },
      { file_id: 'f2', file_key: 'images/b.png', file_name: 'b.png', size_bytes: 2, created_at: '2026-01-01T00:00:00Z' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const objects = [];

    await new Promise((resolve, reject) => {
      s.listObjects('default', 'docs/')
        .on('data', (obj) => objects.push(obj))
        .on('end', resolve)
        .on('error', reject);
    });

    assert.equal(objects.length, 1);
    assert.equal(objects[0].name, 'docs/a.txt');
  });

  it('uses bucket prefix for non-default bucket', async () => {
    pushMock(200, [
      { file_id: 'f1', file_key: 'photos/pic.jpg', file_name: 'pic.jpg', size_bytes: 100, created_at: '2026-01-01T00:00:00Z' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const objects = [];

    await new Promise((resolve, reject) => {
      s.listObjects('photos', 'pic')
        .on('data', (obj) => objects.push(obj))
        .on('end', resolve)
        .on('error', reject);
    });

    assert.equal(objects.length, 1);
  });

  it('uses file_name fallback when file_key missing', async () => {
    pushMock(200, [
      { file_id: 'f1', file_name: 'only-name.txt', size_bytes: 5, created_at: '2026-01-01T00:00:00Z' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const objects = [];

    await new Promise((resolve, reject) => {
      s.listObjects('default')
        .on('data', (obj) => objects.push(obj))
        .on('end', resolve)
        .on('error', reject);
    });

    assert.equal(objects[0].name, 'only-name.txt');
  });

  it('emits error on API failure', async () => {
    pushMock(401, 'Unauthorized');

    const s = new ZeroDBStorage({ accessKey: 'bad', projectId: 'p' });

    await new Promise((resolve) => {
      s.listObjects('default')
        .on('data', () => assert.fail('should not emit data'))
        .on('end', () => assert.fail('should not emit end'))
        .on('error', (err) => {
          assert.match(err.message, /ZeroDB API error 401/);
          resolve();
        });
    });
  });

  it('uses updated_at for lastModified, falls back to created_at', async () => {
    pushMock(200, [
      { file_id: 'f1', file_key: 'a.txt', size_bytes: 0, updated_at: '2026-06-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' },
      { file_id: 'f2', file_key: 'b.txt', size_bytes: 0, created_at: '2026-02-01T00:00:00Z' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const objects = [];

    await new Promise((resolve, reject) => {
      s.listObjects('default')
        .on('data', (obj) => objects.push(obj))
        .on('end', resolve)
        .on('error', reject);
    });

    assert.equal(objects[0].lastModified.toISOString(), '2026-06-01T00:00:00.000Z');
    assert.equal(objects[1].lastModified.toISOString(), '2026-02-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// removeObject
// ---------------------------------------------------------------------------

describe('removeObject', () => {
  it('finds file then deletes it', async () => {
    pushMock(200, [{ file_id: 'rm-1', file_key: 'trash.txt' }]);
    pushMock(200, { message: 'deleted' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.removeObject('default', 'trash.txt');

    assert.equal(mockFetch.calls.length, 2);
    assert.ok(mockFetch.calls[1].url.includes('/files/rm-1'));
  });

  it('is idempotent — no-op when file not found', async () => {
    pushMock(200, []);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.removeObject('default', 'nonexistent.txt');
    assert.equal(mockFetch.calls.length, 1); // only list call
  });

  it('uses bucket prefix for non-default bucket', async () => {
    pushMock(200, [{ file_id: 'rm-2', file_key: 'mybucket/file.txt', file_name: 'file.txt' }]);
    pushMock(200, { message: 'deleted' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.removeObject('mybucket', 'file.txt');
    assert.equal(mockFetch.calls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// deleteFile convenience
// ---------------------------------------------------------------------------

describe('deleteFile', () => {
  it('delegates to removeObject with default bucket', async () => {
    pushMock(200, [{ file_id: 'df-1', file_key: 'bye.txt' }]);
    pushMock(200, { message: 'deleted' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.deleteFile('bye.txt');
    assert.equal(mockFetch.calls.length, 2);
  });
});

// ---------------------------------------------------------------------------
// statObject
// ---------------------------------------------------------------------------

describe('statObject', () => {
  it('returns file metadata', async () => {
    pushMock(200, [{ file_id: 'st-1', file_key: 'info.txt' }]);
    pushMock(200, {
      file_id: 'st-1',
      size_bytes: 4096,
      content_type: 'text/plain',
      file_metadata: { author: 'test' },
      updated_at: '2026-03-01T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const stat = await s.statObject('default', 'info.txt');

    assert.equal(stat.size, 4096);
    assert.equal(stat.etag, 'st-1');
    assert.equal(stat.contentType, 'text/plain');
    assert.deepEqual(stat.metaData, { author: 'test' });
    assert.ok(stat.lastModified instanceof Date);
    assert.equal(stat.lastModified.toISOString(), '2026-03-01T00:00:00.000Z');
  });

  it('throws NoSuchKey when not found', async () => {
    pushMock(200, []);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await assert.rejects(
      () => s.statObject('default', 'nope.txt'),
      (err) => {
        assert.equal(err.code, 'NoSuchKey');
        return true;
      }
    );
  });

  it('defaults to 0 size and octet-stream when metadata sparse', async () => {
    pushMock(200, [{ file_id: 'st-2', file_key: 'sparse.txt' }]);
    pushMock(200, { file_id: 'st-2', created_at: '2026-01-01T00:00:00Z' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const stat = await s.statObject('default', 'sparse.txt');

    assert.equal(stat.size, 0);
    assert.equal(stat.contentType, 'application/octet-stream');
    assert.deepEqual(stat.metaData, {});
  });
});

// ---------------------------------------------------------------------------
// makeBucket / bucketExists / listBuckets
// ---------------------------------------------------------------------------

describe('makeBucket', () => {
  it('is a no-op that does not call fetch', async () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.makeBucket('anything', 'us-east-1');
    assert.equal(mockFetch.calls.length, 0);
  });
});

describe('bucketExists', () => {
  it('always returns true', async () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const result = await s.bucketExists('nonexistent');
    assert.equal(result, true);
  });
});

describe('listBuckets', () => {
  it('returns single default bucket with creationDate', async () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const buckets = await s.listBuckets();

    assert.equal(buckets.length, 1);
    assert.equal(buckets[0].name, 'default');
    assert.ok(buckets[0].creationDate instanceof Date);
  });

  it('returns custom bucket name when configured', async () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p', bucket: 'custom' });
    const buckets = await s.listBuckets();
    assert.equal(buckets[0].name, 'custom');
  });
});

// ---------------------------------------------------------------------------
// uploadFile convenience
// ---------------------------------------------------------------------------

describe('uploadFile', () => {
  it('returns bucket + key + fileId', async () => {
    pushMock(200, { file_id: 'uf-1' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const result = await s.uploadFile('photo.jpg', Buffer.from('img'));

    assert.equal(result.bucket, 'default');
    assert.equal(result.key, 'photo.jpg');
    assert.equal(result.fileId, 'uf-1');
  });

  it('passes metadata through to putObject', async () => {
    pushMock(200, { file_id: 'uf-2' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.uploadFile('doc.txt', 'content', { tags: ['test'] });
    assert.equal(mockFetch.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// listFiles
// ---------------------------------------------------------------------------

describe('listFiles', () => {
  it('returns formatted file list', async () => {
    pushMock(200, [
      {
        file_id: 'lf-1',
        file_key: 'docs/a.pdf',
        file_name: 'a.pdf',
        size_bytes: 1024,
        content_type: 'application/pdf',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        file_metadata: { tag: 'test' },
      },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const files = await s.listFiles();

    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'docs/a.pdf');
    assert.equal(files[0].size, 1024);
    assert.equal(files[0].fileId, 'lf-1');
    assert.equal(files[0].contentType, 'application/pdf');
    assert.deepEqual(files[0].metadata, { tag: 'test' });
    assert.ok(files[0].lastModified instanceof Date);
  });

  it('filters by prefix', async () => {
    pushMock(200, [
      { file_id: 'lf-2', file_key: 'docs/a.pdf', size_bytes: 100, created_at: '2026-01-01T00:00:00Z' },
      { file_id: 'lf-3', file_key: 'images/b.png', size_bytes: 200, created_at: '2026-01-01T00:00:00Z' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const files = await s.listFiles('docs/');

    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'docs/a.pdf');
  });

  it('uses file_name fallback when file_key missing', async () => {
    pushMock(200, [
      { file_id: 'lf-4', file_name: 'onlyname.txt', size_bytes: 50, created_at: '2026-01-01T00:00:00Z' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const files = await s.listFiles();
    assert.equal(files[0].name, 'onlyname.txt');
  });

  it('returns empty array for no matching prefix', async () => {
    pushMock(200, [
      { file_id: 'lf-5', file_key: 'a.txt', size_bytes: 10, created_at: '2026-01-01T00:00:00Z' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const files = await s.listFiles('nonexistent/');
    assert.equal(files.length, 0);
  });
});

// ---------------------------------------------------------------------------
// getStats
// ---------------------------------------------------------------------------

describe('getStats', () => {
  it('returns stats from API', async () => {
    pushMock(200, { total_files: 42, total_bytes: 1048576 });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const stats = await s.getStats();

    assert.equal(stats.total_files, 42);
    assert.equal(stats.total_bytes, 1048576);
  });
});

// ---------------------------------------------------------------------------
// _findFileId internals
// ---------------------------------------------------------------------------

describe('_findFileId', () => {
  it('finds by file_key match', async () => {
    pushMock(200, [
      { file_id: 'ff-1', file_key: 'target.txt', file_name: 'other.txt' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const id = await s._findFileId('default', 'target.txt');
    assert.equal(id, 'ff-1');
  });

  it('finds by file_name match as fallback', async () => {
    pushMock(200, [
      { file_id: 'ff-2', file_key: 'other.txt', file_name: 'target.txt' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const id = await s._findFileId('default', 'target.txt');
    assert.equal(id, 'ff-2');
  });

  it('returns null when no match', async () => {
    pushMock(200, [
      { file_id: 'ff-3', file_key: 'nope.txt', file_name: 'also-nope.txt' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const id = await s._findFileId('default', 'missing.txt');
    assert.equal(id, null);
  });

  it('builds correct storageKey for non-default bucket', async () => {
    pushMock(200, [
      { file_id: 'ff-4', file_key: 'photos/pic.jpg' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const id = await s._findFileId('photos', 'pic.jpg');
    assert.equal(id, 'ff-4');
  });
});

// ---------------------------------------------------------------------------
// Error handling — various HTTP status codes
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('401 error', async () => {
    pushMock(401, 'Unauthorized');

    const s = new ZeroDBStorage({ accessKey: 'bad', projectId: 'p' });
    await assert.rejects(
      () => s.listFiles(),
      (err) => {
        assert.match(err.message, /ZeroDB API error 401/);
        assert.equal(err.statusCode, 401);
        return true;
      }
    );
  });

  it('404 error', async () => {
    pushMock(404, 'Not Found');

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await assert.rejects(
      () => s.getStats(),
      (err) => {
        assert.match(err.message, /ZeroDB API error 404/);
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  it('500 error', async () => {
    pushMock(500, 'Internal Server Error');

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await assert.rejects(
      () => s.listFiles(),
      (err) => {
        assert.match(err.message, /ZeroDB API error 500/);
        assert.equal(err.statusCode, 500);
        return true;
      }
    );
  });

  it('network error (fetch throws)', async () => {
    globalThis.fetch = async () => { throw new Error('Network failure'); };

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await assert.rejects(
      () => s.listFiles(),
      (err) => {
        assert.match(err.message, /Network failure/);
        return true;
      }
    );
  });

  it('non-JSON response body in error', async () => {
    pushMock(403, 'Forbidden plain text', 'text/plain');

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await assert.rejects(
      () => s.listFiles(),
      (err) => {
        assert.match(err.message, /403/);
        return true;
      }
    );
  });

  it('res.text() failure is caught gracefully', async () => {
    // Custom mock where text() throws
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      headers: { get: () => null },
      text: async () => { throw new Error('body stream consumed'); },
    });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await assert.rejects(
      () => s.listFiles(),
      (err) => {
        assert.match(err.message, /ZeroDB API error 502/);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// httpRequest — non-JSON content type
// ---------------------------------------------------------------------------

describe('httpRequest content-type handling', () => {
  it('returns raw response for non-JSON responses', async () => {
    pushMock(200, 'raw data', 'text/plain');

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    // getStats calls httpRequest — but we need a non-JSON response
    // Let's use the stats endpoint which returns httpRequest result
    const result = await s.getStats();
    // When non-JSON, httpRequest returns the response object itself
    assert.ok(result);
  });
});
