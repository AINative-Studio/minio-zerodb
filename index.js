/**
 * minio-zerodb — Drop-in MinIO replacement with ZeroDB cloud storage backend.
 *
 * Zero config: auto-provisions a free ZeroDB project on first use.
 * MinIO-compatible API surface: putObject, getObject, presignedGetObject,
 * listObjects, removeObject, makeBucket, listBuckets.
 *
 * Under the hood, this wraps ZeroDB's REST file storage API rather than
 * speaking raw S3 protocol, so it works everywhere (Edge, serverless, Node).
 */

const ZERODB_API_BASE = 'https://api.ainative.studio';
const INSTANT_DB_ENDPOINT = `${ZERODB_API_BASE}/api/v1/public/instant-db`;
const DEFAULT_BUCKET = 'default';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStorageUrl(projectId) {
  return `${ZERODB_API_BASE}/v1/zerodb/${projectId}/database`;
}

async function httpRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...options.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`ZeroDB API error ${res.status}: ${body}`);
    err.statusCode = res.status;
    throw err;
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return res;
}

// ---------------------------------------------------------------------------
// Auto-provisioning
// ---------------------------------------------------------------------------

async function autoProvision() {
  const data = await httpRequest(INSTANT_DB_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'minio-zerodb' }),
  });

  return {
    projectId: data.project_id,
    apiKey: data.api_key,
    claimUrl: data.claim_url || null,
  };
}

// ---------------------------------------------------------------------------
// Readable stream helper for getObject compatibility
// ---------------------------------------------------------------------------

function bufferToReadable(buffer) {
  const { Readable } = require('stream');
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

// ---------------------------------------------------------------------------
// ZeroDBStorage — MinIO-compatible client
// ---------------------------------------------------------------------------

export class ZeroDBStorage {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.accessKey]  — ZeroDB API key (env: ZERODB_API_KEY or MINIO_ACCESS_KEY)
   * @param {string} [opts.secretKey]  — Not used by ZeroDB but accepted for MinIO compat
   * @param {string} [opts.projectId]  — ZeroDB project ID (env: ZERODB_PROJECT_ID)
   * @param {string} [opts.endPoint]   — API base URL (default: api.ainative.studio)
   * @param {string} [opts.bucket]     — Default bucket name (logical grouping, default: 'default')
   * @param {number} [opts.port]       — Ignored (kept for MinIO constructor compat)
   * @param {boolean} [opts.useSSL]    — Ignored (always HTTPS)
   */
  constructor(opts = {}) {
    this._apiKey = opts.accessKey || opts.secretKey || process.env.ZERODB_API_KEY || process.env.MINIO_ACCESS_KEY || '';
    this._projectId = opts.projectId || process.env.ZERODB_PROJECT_ID || '';
    this._endPoint = opts.endPoint || process.env.ZERODB_ENDPOINT || ZERODB_API_BASE;
    this._defaultBucket = opts.bucket || DEFAULT_BUCKET;
    this._provisioned = false;
    this._provisionPromise = null;

    // Store original opts for MinIO compat surface
    this.endPoint = opts.endPoint || 'api.ainative.studio';
    this.port = opts.port || 443;
    this.useSSL = opts.useSSL !== false;
    this.accessKey = this._apiKey;
    this.secretKey = opts.secretKey || this._apiKey;
  }

  // -----------------------------------------------------------------------
  // Internal: ensure we have a project + API key
  // -----------------------------------------------------------------------

  async _ensureProvisioned() {
    if (this._apiKey && this._projectId) {
      return;
    }

    // Deduplicate concurrent provisioning calls
    if (this._provisionPromise) {
      await this._provisionPromise;
      return;
    }

    this._provisionPromise = (async () => {
      const result = await autoProvision();
      this._projectId = result.projectId;
      this._apiKey = result.apiKey;
      this.accessKey = result.apiKey;
      this.secretKey = result.apiKey;
      this._provisioned = true;

      if (result.claimUrl) {
        console.log(`\n  ZeroDB storage auto-provisioned (free, 72h trial).`);
        console.log(`  Claim to keep permanently: ${result.claimUrl}\n`);
      }
    })();

    await this._provisionPromise;
  }

  _headers() {
    return {
      'X-API-Key': this._apiKey,
    };
  }

  _storageUrl() {
    return `${this._endPoint}/v1/zerodb/${this._projectId}/database`;
  }

  // -----------------------------------------------------------------------
  // MinIO-compatible methods
  // -----------------------------------------------------------------------

  /**
   * Upload an object. MinIO signature: putObject(bucket, name, data, size?, metadata?)
   */
  async putObject(bucket, objectName, data, size, metadata) {
    await this._ensureProvisioned();

    // Build form data
    const FormData = (await import('node:buffer')).FormData || globalThis.FormData;
    let formData;

    // Determine if data is a Buffer, Stream, or string
    let blob;
    if (Buffer.isBuffer(data)) {
      blob = new Blob([data]);
    } else if (typeof data === 'string') {
      blob = new Blob([data]);
    } else if (data && typeof data.read === 'function') {
      // Readable stream — collect into buffer
      const chunks = [];
      for await (const chunk of data) {
        chunks.push(chunk);
      }
      blob = new Blob([Buffer.concat(chunks)]);
    } else {
      blob = new Blob([data]);
    }

    // Use native fetch with FormData
    const form = new FormData();
    form.append('file', blob, objectName.split('/').pop());

    // Use the full path as the storage key
    const storageKey = bucket === DEFAULT_BUCKET ? objectName : `${bucket}/${objectName}`;
    form.append('key', storageKey);

    if (metadata && typeof metadata === 'object') {
      form.append('metadata', JSON.stringify(metadata));
    }

    const result = await httpRequest(`${this._storageUrl()}/storage/upload`, {
      method: 'POST',
      headers: this._headers(),
      body: form,
    });

    return {
      etag: result.file_id || '',
      versionId: null,
    };
  }

  /**
   * Get an object as a readable stream. MinIO signature: getObject(bucket, name)
   */
  async getObject(bucket, objectName) {
    await this._ensureProvisioned();

    // First find the file by listing and matching key
    const fileId = await this._findFileId(bucket, objectName);
    if (!fileId) {
      const err = new Error(`Object not found: ${bucket}/${objectName}`);
      err.code = 'NoSuchKey';
      throw err;
    }

    // Get download URL
    const downloadInfo = await httpRequest(
      `${this._storageUrl()}/files/${fileId}/download`,
      { headers: this._headers() }
    );

    // Fetch actual content
    const res = await fetch(downloadInfo.download_url);
    if (!res.ok) {
      throw new Error(`Download failed: ${res.status}`);
    }

    // Return as readable stream (Node.js compat)
    if (typeof res.body?.pipe === 'function') {
      return res.body;
    }

    // Convert web ReadableStream to Node stream
    const buffer = Buffer.from(await res.arrayBuffer());
    return bufferToReadable(buffer);
  }

  /**
   * Generate a presigned GET URL. MinIO signature: presignedGetObject(bucket, name, expiry?)
   */
  async presignedGetObject(bucket, objectName, expiry = 3600) {
    await this._ensureProvisioned();

    const fileId = await this._findFileId(bucket, objectName);
    if (!fileId) {
      const err = new Error(`Object not found: ${bucket}/${objectName}`);
      err.code = 'NoSuchKey';
      throw err;
    }

    const result = await httpRequest(
      `${this._storageUrl()}/files/${fileId}/presigned-url`,
      {
        method: 'POST',
        headers: {
          ...this._headers(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ expiration: expiry, operation: 'download' }),
      }
    );

    return result.presigned_url || result.url;
  }

  /**
   * List objects in a bucket. Returns an async iterator for MinIO compat.
   */
  listObjects(bucket, prefix = '', recursive = true) {
    const self = this;

    // Return an EventEmitter-like async iterator (MinIO pattern)
    const events = [];
    let ended = false;
    let error = null;
    const listeners = { data: [], end: [], error: [] };

    const emitter = {
      on(event, fn) {
        listeners[event] = listeners[event] || [];
        listeners[event].push(fn);
        return emitter;
      },
    };

    // Start fetching in background
    (async () => {
      try {
        await self._ensureProvisioned();

        const files = await httpRequest(
          `${self._storageUrl()}/files?skip=0&limit=1000`,
          { headers: self._headers() }
        );

        const keyPrefix = bucket === DEFAULT_BUCKET ? prefix : `${bucket}/${prefix}`;

        for (const file of files) {
          const key = file.file_key || file.file_name;
          if (prefix && !key.startsWith(keyPrefix)) continue;

          const obj = {
            name: key,
            size: file.size_bytes || 0,
            etag: file.file_id,
            lastModified: new Date(file.updated_at || file.created_at),
            prefix: '',
          };

          for (const fn of listeners.data || []) fn(obj);
        }

        for (const fn of listeners.end || []) fn();
      } catch (err) {
        for (const fn of listeners.error || []) fn(err);
      }
    })();

    return emitter;
  }

  /**
   * Remove an object. MinIO signature: removeObject(bucket, name)
   */
  async removeObject(bucket, objectName) {
    await this._ensureProvisioned();

    const fileId = await this._findFileId(bucket, objectName);
    if (!fileId) return; // MinIO removeObject is idempotent

    await httpRequest(`${this._storageUrl()}/files/${fileId}`, {
      method: 'DELETE',
      headers: this._headers(),
    });
  }

  /**
   * Stat an object. MinIO signature: statObject(bucket, name)
   */
  async statObject(bucket, objectName) {
    await this._ensureProvisioned();

    const fileId = await this._findFileId(bucket, objectName);
    if (!fileId) {
      const err = new Error(`Object not found: ${bucket}/${objectName}`);
      err.code = 'NoSuchKey';
      throw err;
    }

    const meta = await httpRequest(
      `${this._storageUrl()}/files/${fileId}`,
      { headers: this._headers() }
    );

    return {
      size: meta.size_bytes || 0,
      etag: meta.file_id,
      lastModified: new Date(meta.updated_at || meta.created_at),
      metaData: meta.file_metadata || {},
      contentType: meta.content_type || 'application/octet-stream',
    };
  }

  /**
   * Make a bucket. ZeroDB uses a single bucket per project,
   * so this is a no-op that succeeds silently.
   */
  async makeBucket(bucket, region) {
    await this._ensureProvisioned();
    // ZeroDB manages buckets internally per project — no-op
  }

  /**
   * List buckets. Returns the default logical bucket.
   */
  async listBuckets() {
    await this._ensureProvisioned();
    return [
      {
        name: this._defaultBucket,
        creationDate: new Date(),
      },
    ];
  }

  /**
   * Check if a bucket exists. Always true after provisioning.
   */
  async bucketExists(bucket) {
    await this._ensureProvisioned();
    return true;
  }

  // -----------------------------------------------------------------------
  // Convenience methods (beyond MinIO API)
  // -----------------------------------------------------------------------

  /**
   * Upload a file with a simple name + data interface.
   * @param {string} name — Object key / path
   * @param {Buffer|string|ReadableStream} data — File content
   * @param {Object} [metadata] — Optional metadata
   * @returns {{ bucket: string, key: string, fileId: string }}
   */
  async uploadFile(name, data, metadata) {
    const result = await this.putObject(this._defaultBucket, name, data, undefined, metadata);
    return { bucket: this._defaultBucket, key: name, fileId: result.etag };
  }

  /**
   * Download a file by name. Returns a Node.js Readable stream.
   */
  async downloadFile(name) {
    return this.getObject(this._defaultBucket, name);
  }

  /**
   * List all files in the project.
   * @returns {Promise<Array<{ name, size, lastModified, fileId }>>}
   */
  async listFiles(prefix = '') {
    await this._ensureProvisioned();

    const files = await httpRequest(
      `${this._storageUrl()}/files?skip=0&limit=1000`,
      { headers: this._headers() }
    );

    return files
      .filter((f) => !prefix || (f.file_key || f.file_name).startsWith(prefix))
      .map((f) => ({
        name: f.file_key || f.file_name,
        size: f.size_bytes || 0,
        lastModified: new Date(f.updated_at || f.created_at),
        fileId: f.file_id,
        contentType: f.content_type,
        metadata: f.file_metadata,
      }));
  }

  /**
   * Get a presigned download URL for a file.
   * @param {string} name — Object key
   * @param {number} [expiry=3600] — URL validity in seconds
   */
  async getUrl(name, expiry = 3600) {
    return this.presignedGetObject(this._defaultBucket, name, expiry);
  }

  /**
   * Delete a file by name.
   */
  async deleteFile(name) {
    return this.removeObject(this._defaultBucket, name);
  }

  /**
   * Get storage statistics for the project.
   */
  async getStats() {
    await this._ensureProvisioned();

    return httpRequest(`${this._storageUrl()}/files/stats`, {
      headers: this._headers(),
    });
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Find a file_id by its key/name path. Caches the file list for
   * batch operations within the same tick.
   */
  async _findFileId(bucket, objectName) {
    const storageKey = bucket === DEFAULT_BUCKET ? objectName : `${bucket}/${objectName}`;

    const files = await httpRequest(
      `${this._storageUrl()}/files?skip=0&limit=1000`,
      { headers: this._headers() }
    );

    const match = files.find(
      (f) => f.file_key === storageKey || f.file_name === storageKey
    );

    return match ? match.file_id : null;
  }
}

// ---------------------------------------------------------------------------
// Named exports for convenience
// ---------------------------------------------------------------------------

export { ZeroDBStorage as Client };
export default ZeroDBStorage;
