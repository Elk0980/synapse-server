'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { fail, hash, opaque, clone } = require('./core');

function emptyState() {
  return { version: 1, profiles: {}, connections: {}, bindings: {}, objects: {}, policies: {},
    proposals: {}, approvals: {}, jobs: {}, resources: {}, quotas: {}, audit: [] };
}

// Single local filesystem, not NFS. No awaited code inside a transaction.
// A crashed transaction lock is never stolen on a timeout: an operator must first
// prove that the former process is stopped. Resource leases are separate job data.
class FileStore {
  #root;
  constructor(directory) {
    this.#root = path.resolve(directory);
    fs.mkdirSync(this.#root, { recursive: true, mode: 0o700 });
    this.transaction(() => {});
  }
  transaction(callback) {
    const lock = path.join(this.#root, 'transaction.lock');
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch { fail('STORE_BUSY'); }
    let temp;
    try {
      const file = path.join(this.#root, 'state.json');
      const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : emptyState();
      if (state.version !== 1) fail('STORE_VERSION_UNSUPPORTED');
      const result = callback(state);
      if (result && typeof result.then === 'function') fail('ASYNC_TRANSACTION_FORBIDDEN');
      temp = path.join(this.#root, `${opaque()}.tmp`);
      const handle = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(handle, JSON.stringify(state)); fs.fsyncSync(handle); }
      finally { fs.closeSync(handle); }
      fs.renameSync(temp, file);
      // Directory fsync is supported on POSIX; Windows rejects opening directories.
      if (process.platform !== 'win32') {
        const directory = fs.openSync(this.#root, 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      }
      return clone(result);
    } catch (error) {
      if (error?.name === 'IntegrationError') throw error;
      fail('STORE_FAILURE'); // Never expose paths, database contents or arbitrary error text.
    } finally {
      if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
      fs.rmdirSync(lock);
    }
  }
  read(callback) { return this.transaction(callback); }
}

function audit(state, actor, companyId, event, details = {}) {
  // Callers pass only IDs, hashes and controlled codes; never transport payloads.
  const previous = state.audit.at(-1)?.digest || null;
  const record = { sequence: state.audit.length + 1, createdAt: new Date().toISOString(), actorId: actor.id, companyId,
    event, details, previous };
  state.audit.push({ ...record, digest: hash(record) });
}

module.exports = { FileStore, audit };
