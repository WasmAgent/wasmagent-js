/**
 * Tiny LRU cache used by web-search tool adapters to skip duplicate
 * provider calls within a short window. No external dep.
 */

interface CacheEntry<V> {
  value: V;
  expiresAt: number;
}

export class LruCache<K, V> {
  readonly #max: number;
  readonly #map = new Map<K, CacheEntry<V>>();

  constructor(max = 100) {
    this.#max = Math.max(1, max);
  }

  get(key: K): V | undefined {
    const entry = this.#map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt > 0 && entry.expiresAt < Date.now()) {
      this.#map.delete(key);
      return undefined;
    }
    // refresh recency
    this.#map.delete(key);
    this.#map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, ttlMs = 0): void {
    if (this.#map.has(key)) this.#map.delete(key);
    this.#map.set(key, {
      value,
      expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0,
    });
    while (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value as K | undefined;
      if (oldest === undefined) break;
      this.#map.delete(oldest);
    }
  }

  size(): number {
    return this.#map.size;
  }

  clear(): void {
    this.#map.clear();
  }
}
