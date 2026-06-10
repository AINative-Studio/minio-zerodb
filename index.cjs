/**
 * minio-zerodb — CommonJS entry point.
 *
 * Drop-in MinIO replacement with ZeroDB cloud storage backend.
 * Zero config: auto-provisions a free ZeroDB project on first use.
 */

'use strict';

const ZERODB_API_BASE = 'https://api.ainative.studio';
const INSTANT_DB_ENDPOINT = `${ZERODB_API_BASE}/api/v1/public/instant-db`;
const DEFAULT_BUCKET = 'default';

function buildStorageUrl(endPoint, projectId) {
  return `${endPoint}/v1/zerodb/${projectId}/database`;
}

async function httpRequest(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { ...options.headers },
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

function bufferToReadable(buffer) {
  const { Readable } = require('stream');
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

class ZeroDBStorage {
  constructor(opts = {}) {
    this._apiKey = opts.accessKey || opts.secretKey || process.env.ZERODB_API_KEY || process.env.MINIO_ACCESS_KEY || '';
    this._projectId = opts.projectId || process.env.ZERODB_PROJECT_ID || '';
    this._endPoint = opts.endPoint || process.env.ZERODB_ENDPOINT || ZERODB_API_BASE;
    this._defaultBucket = opts.bucket || DEFAULT_BUCKET;
    this._provisioned = false;
    this._provisionPromise = null;

    this.endPoint = opts.endPoint || 'api.ainative.studio';
    this.port = opts.port || 443;
    this.useSSL = opts.useSSL !== false;
    this.accessKey = this._apiKey;
    this.secretKey = opts.secretKey || this._apiKey;
  }

  async _ensureProvisioned() {
    if (this._apiKey && this._projectId) return;

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
    return { 'X-API-Key': this._apiKey };
  }

  _storageUrl() {
    return buildStorageUrl(this._endPoint, this._projectId);
  }

  async putObject(bucket, objectName, data, size, metadata) {
    await this._ensureProvisioned();

    let blob;
    if (Buffer.isBuffer(data)) {
      blob = new Blob([data]);
    } else if (typeof data === 'string') {
      blob = new Blob([data]);
    } else if (data && typeof data[Symbol.asyncIterator] === 'function') {
      const chunks = [];
      for await (const chunk of data) chunks.push(chunk);
      blob = new Blob([Buffer.concat(chunks)]);
    } else {
      blob = new Blob([data]);
    }

    const form = new FormData();
    form.append('file', blob, objectName.split('/').pop());

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

    return { etag: result.file_id || '', versionId: null };
  }

  async getObject(bucket, objectName) {
    await this._ensureProvisioned();

    const fileId = await this._findFileId(bucket, objectName);
    if (!fileId) {
      const err = new Error(`Object not found: ${bucket}/${objectName}`);
      err.code = 'NoSuchKey';
      throw err;
    }

    const downloadInfo = await httpRequest(
      `${this._storageUrl()}/files/${fileId}/download`,
      { headers: this._headers() }
    );

    const res = await fetch(downloadInfo.download_url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    const buffer = Buffer.from(await res.arrayBuffer());
    return bufferToReadable(buffer);
  }

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
        headers: { ...this._headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiration: expiry, operation: 'download' }),
      }
    );

    return result.presigned_url || result.url;
  }

  listObjects(bucket, prefix = '', recursive = true) {
    const self = this;
    const listeners = { data: [], end: [], error: [] };

    const emitter = {
      on(event, fn) {
        listeners[event] = listeners[event] || [];
        listeners[event].push(fn);
        return emitter;
      },
    };

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
          for (const fn of listeners.data || []) {
            fn({
              name: key,
              size: file.size_bytes || 0,
              etag: file.file_id,
              lastModified: new Date(file.updated_at || file.created_at),
              prefix: '',
            });
          }
        }
        for (const fn of listeners.end || []) fn();
      } catch (err) {
        for (const fn of listeners.error || []) fn(err);
      }
    })();

    return emitter;
  }

  async removeObject(bucket, objectName) {
    await this._ensureProvisioned();
    const fileId = await this._findFileId(bucket, objectName);
    if (!fileId) return;
    await httpRequest(`${this._storageUrl()}/files/${fileId}`, {
      method: 'DELETE',
      headers: this._headers(),
    });
  }

  async statObject(bucket, objectName) {
    await this._ensureProvisioned();
    const fileId = await this._findFileId(bucket, objectName);
    if (!fileId) {
      const err = new Error(`Object not found: ${bucket}/${objectName}`);
      err.code = 'NoSuchKey';
      throw err;
    }
    const meta = await httpRequest(`${this._storageUrl()}/files/${fileId}`, {
      headers: this._headers(),
    });
    return {
      size: meta.size_bytes || 0,
      etag: meta.file_id,
      lastModified: new Date(meta.updated_at || meta.created_at),
      metaData: meta.file_metadata || {},
      contentType: meta.content_type || 'application/octet-stream',
    };
  }

  async makeBucket() { await this._ensureProvisioned(); }
  async listBuckets() {
    await this._ensureProvisioned();
    return [{ name: this._defaultBucket, creationDate: new Date() }];
  }
  async bucketExists() { await this._ensureProvisioned(); return true; }

  // Convenience methods
  async uploadFile(name, data, metadata) {
    const result = await this.putObject(this._defaultBucket, name, data, undefined, metadata);
    return { bucket: this._defaultBucket, key: name, fileId: result.etag };
  }

  async downloadFile(name) { return this.getObject(this._defaultBucket, name); }

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

  async getUrl(name, expiry = 3600) { return this.presignedGetObject(this._defaultBucket, name, expiry); }
  async deleteFile(name) { return this.removeObject(this._defaultBucket, name); }

  async getStats() {
    await this._ensureProvisioned();
    return httpRequest(`${this._storageUrl()}/files/stats`, { headers: this._headers() });
  }

  async _findFileId(bucket, objectName) {
    const storageKey = bucket === DEFAULT_BUCKET ? objectName : `${bucket}/${objectName}`;
    const files = await httpRequest(
      `${this._storageUrl()}/files?skip=0&limit=1000`,
      { headers: this._headers() }
    );
    const match = files.find((f) => f.file_key === storageKey || f.file_name === storageKey);
    return match ? match.file_id : null;
  }
}

module.exports = ZeroDBStorage;
module.exports.ZeroDBStorage = ZeroDBStorage;
module.exports.Client = ZeroDBStorage;
module.exports.default = ZeroDBStorage;
