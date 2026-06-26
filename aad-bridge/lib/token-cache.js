'use strict';

/**
 * In-process access-token cache with single-flight refresh.
 *
 * A single shared identity backs every caller, so the daemon caches one token per (resource, tenant) and multiplexes it to all clients.
 * Concurrent misses for the same key collapse into one `az` invocation, so a burst of kubectl calls never spawns a burst of az processes.
 */

const { getAccessToken } = require('./az');

class TokenCache {
  constructor(config) {
    this.config = config;
    this.entries = new Map(); // key -> { token, expiresOn, tokenType }
    this.inflight = new Map(); // key -> Promise
  }

  static key(resource, tenant, subscription) {
    return `${resource}|${tenant || ''}|${subscription || ''}`;
  }

  /** True when an entry is missing or within the refresh skew of expiry. */
  isStale(entry) {
    if (!entry) return true;
    const nowSec = Math.floor(Date.now() / 1000);
    return entry.expiresOn - this.config.refreshSkewSeconds <= nowSec;
  }

  /**
   * Return a fresh token for the resource, refreshing via az when stale.
   * @returns {Promise<{token, expiresOn, tokenType}>}
   */
  async get({ resource, tenant, subscription }) {
    const key = TokenCache.key(resource, tenant, subscription);
    const cached = this.entries.get(key);
    if (!this.isStale(cached)) {
      // Touch for LRU recency: re-insert so this key is now the most recent.
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }

    if (this.inflight.has(key)) return this.inflight.get(key);

    const promise = getAccessToken({ resource, tenant, subscription, config: this.config })
      .then((entry) => {
        this.entries.set(key, entry);
        this.evict();
        return entry;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, promise);
    return promise;
  }

  /** Evict least-recently-used entries once the cache exceeds its cap (0 = unbounded). */
  evict() {
    const max = this.config.cacheMaxEntries;
    if (!max || max <= 0) return;
    while (this.entries.size > max) {
      const oldest = this.entries.keys().next().value; // Map iterates in insertion order
      this.entries.delete(oldest);
    }
  }

  /** Metadata snapshot for /debug — token values are deliberately omitted. */
  snapshot() {
    const nowSec = Math.floor(Date.now() / 1000);
    return [...this.entries.entries()].map(([key, e]) => {
      const [resource, tenant, subscription] = key.split('|');
      return {
        resource,
        tenant: tenant || null,
        subscription: subscription || null,
        expiresOn: e.expiresOn,
        expiresInSec: e.expiresOn - nowSec,
        stale: this.isStale(e),
      };
    });
  }
}

module.exports = { TokenCache };
