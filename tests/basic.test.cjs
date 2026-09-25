/**
 * minio-zerodb unit tests.
 *
 * All HTTP calls are mocked via globalThis.fetch — no real API calls.
 */

const { ZeroDBStorage, Client } = require('../index.cjs');

// ---------------------------------------------------------------------------
// Mock fetch
// ---------------------------------------------------------------------------

const mockResponses = [];

function pushMock(status, body, contentType = 'application/json') {
  mockResponses.push({ status, body, contentType });
}

function createMockFetch() {
  return jest.fn(async (url, opts) => {
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
    };
  });
}

beforeEach(() => {
  mockResponses.length = 0;
  globalThis.fetch = createMockFetch();
});

afterEach(() => {
  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ZeroDBStorage constructor', () => {
  test('uses provided credentials', () => {
    const s = new ZeroDBStorage({
      accessKey: 'test-key',
      projectId: 'test-project',
    });

    expect(s._apiKey).toBe('test-key');
    expect(s._projectId).toBe('test-project');
    expect(s.endPoint).toBe('api.ainative.studio');
    expect(s.port).toBe(443);
    expect(s.useSSL).toBe(true);
  });

  test('reads from environment variables', () => {
    process.env.ZERODB_API_KEY = 'env-key';
    process.env.ZERODB_PROJECT_ID = 'env-project';

    const s = new ZeroDBStorage();
    expect(s._apiKey).toBe('env-key');
    expect(s._projectId).toBe('env-project');

    delete process.env.ZERODB_API_KEY;
    delete process.env.ZERODB_PROJECT_ID;
  });

  test('accepts MINIO_ACCESS_KEY for compat', () => {
    process.env.MINIO_ACCESS_KEY = 'minio-key';

    const s = new ZeroDBStorage();
    expect(s._apiKey).toBe('minio-key');

    delete process.env.MINIO_ACCESS_KEY;
  });

  test('default bucket is "default"', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    expect(s._defaultBucket).toBe('default');
  });

  test('custom bucket', () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p', bucket: 'photos' });
    expect(s._defaultBucket).toBe('photos');
  });
});

describe('Client export', () => {
  test('Client is ZeroDBStorage', () => {
    expect(Client).toBe(ZeroDBStorage);
  });
});

describe('auto-provisioning', () => {
  test('provisions when no credentials', async () => {
    // Mock instant-db response
    pushMock(200, {
      project_id: 'auto-proj-123',
      api_key: 'auto-key-456',
      claim_url: 'https://example.test/claim/abc',
    });

    // Mock listBuckets (which calls _ensureProvisioned)
    const s = new ZeroDBStorage();
    const buckets = await s.listBuckets();

    expect(s._projectId).toBe('auto-proj-123');
    expect(s._apiKey).toBe('auto-key-456');
    expect(s._provisioned).toBe(true);
    expect(buckets).toHaveLength(1);
    expect(buckets[0].name).toBe('default');
  });

  test('skips provisioning when credentials exist', async () => {
    const s = new ZeroDBStorage({ accessKey: 'existing', projectId: 'existing-proj' });
    const buckets = await s.listBuckets();

    // No fetch should have been called for provisioning
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(buckets).toHaveLength(1);
  });
});

describe('putObject', () => {
  test('uploads a buffer', async () => {
    pushMock(200, {
      success: true,
      file_id: 'file-abc',
      file_key: 'test.txt',
    });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const result = await s.putObject('default', 'test.txt', Buffer.from('hello'));

    expect(result.etag).toBe('file-abc');
    expect(result.versionId).toBeNull();
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const [url] = globalThis.fetch.mock.calls[0];
    expect(url).toContain('/v1/zerodb/p/database/storage/upload');
  });

  test('uploads a string', async () => {
    pushMock(200, { success: true, file_id: 'file-str' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const result = await s.putObject('my-bucket', 'notes.txt', 'hello world');

    expect(result.etag).toBe('file-str');
  });
});

describe('uploadFile convenience', () => {
  test('returns bucket + key + fileId', async () => {
    pushMock(200, { success: true, file_id: 'conv-file' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const result = await s.uploadFile('photo.jpg', Buffer.from('img'));

    expect(result.bucket).toBe('default');
    expect(result.key).toBe('photo.jpg');
    expect(result.fileId).toBe('conv-file');
  });
});

describe('listFiles', () => {
  test('returns formatted file list', async () => {
    pushMock(200, [
      {
        file_id: 'f1',
        file_key: 'docs/a.pdf',
        file_name: 'a.pdf',
        size_bytes: 1024,
        content_type: 'application/pdf',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-02T00:00:00Z',
        file_metadata: { tag: 'test' },
      },
      {
        file_id: 'f2',
        file_key: 'images/b.png',
        file_name: 'b.png',
        size_bytes: 2048,
        content_type: 'image/png',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
        file_metadata: {},
      },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const files = await s.listFiles();

    expect(files).toHaveLength(2);
    expect(files[0].name).toBe('docs/a.pdf');
    expect(files[0].size).toBe(1024);
    expect(files[0].fileId).toBe('f1');
    expect(files[1].contentType).toBe('image/png');
  });

  test('filters by prefix', async () => {
    pushMock(200, [
      { file_id: 'f1', file_key: 'docs/a.pdf', size_bytes: 100, created_at: '2026-01-01T00:00:00Z' },
      { file_id: 'f2', file_key: 'images/b.png', size_bytes: 200, created_at: '2026-01-01T00:00:00Z' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const files = await s.listFiles('docs/');

    expect(files).toHaveLength(1);
    expect(files[0].name).toBe('docs/a.pdf');
  });
});

describe('removeObject', () => {
  test('deletes by finding file ID first', async () => {
    // Mock file list to find the file
    pushMock(200, [
      { file_id: 'del-123', file_key: 'trash.txt', size_bytes: 10, created_at: '2026-01-01T00:00:00Z' },
    ]);
    // Mock delete
    pushMock(200, { message: 'File deleted successfully', file_id: 'del-123' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.removeObject('default', 'trash.txt');

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const [deleteUrl] = globalThis.fetch.mock.calls[1];
    expect(deleteUrl).toContain('/files/del-123');
  });

  test('is idempotent when file not found', async () => {
    pushMock(200, []);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.removeObject('default', 'nonexistent.txt');

    // Only one call (list), no delete call
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('deleteFile convenience', () => {
  test('delegates to removeObject', async () => {
    pushMock(200, [{ file_id: 'x', file_key: 'bye.txt', size_bytes: 1, created_at: '2026-01-01T00:00:00Z' }]);
    pushMock(200, { message: 'deleted' });

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.deleteFile('bye.txt');

    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });
});

describe('makeBucket / bucketExists / listBuckets', () => {
  test('makeBucket is a no-op', async () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    await s.makeBucket('anything');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  test('bucketExists returns true', async () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const exists = await s.bucketExists('anything');
    expect(exists).toBe(true);
  });

  test('listBuckets returns default bucket', async () => {
    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const buckets = await s.listBuckets();
    expect(buckets).toHaveLength(1);
    expect(buckets[0].name).toBe('default');
  });
});

describe('listObjects EventEmitter pattern', () => {
  test('emits data and end events', (done) => {
    pushMock(200, [
      { file_id: 'f1', file_key: 'a.txt', size_bytes: 10, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    ]);

    const s = new ZeroDBStorage({ accessKey: 'k', projectId: 'p' });
    const objects = [];

    s.listObjects('default')
      .on('data', (obj) => objects.push(obj))
      .on('end', () => {
        expect(objects).toHaveLength(1);
        expect(objects[0].name).toBe('a.txt');
        expect(objects[0].size).toBe(10);
        done();
      })
      .on('error', done);
  });
});

describe('error handling', () => {
  test('API errors are thrown with status code', async () => {
    pushMock(403, { error: 'Forbidden' });

    const s = new ZeroDBStorage({ accessKey: 'bad-key', projectId: 'p' });
    await expect(s.listFiles()).rejects.toThrow('ZeroDB API error 403');
  });
});
