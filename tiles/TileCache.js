import * as THREE from 'three';

export default class TileCache {
    constructor({ maxEntries = 256, concurrency = 8 } = {}) {
        this.maxEntries = maxEntries;
        this.concurrency = concurrency;
        this.cache = new Map(); // Key -> { texture, timestamp, refCount }
        this.pendingRequests = new Map(); // Key -> Promise
        this.activeRequests = 0;
        this.queue = []; // Queue of { url, resolve, reject }
        this.textureLoader = new THREE.TextureLoader();
    }

    get(key) {
        const entry = this.cache.get(key);
        if (entry) {
            entry.timestamp = Date.now();
            return entry.texture;
        }
        return null;
    }

    async loadTile(url, key) {
        // Check cache first
        const cached = this.get(key);
        if (cached) return cached;

        // Check if already pending
        if (this.pendingRequests.has(key)) {
            return this.pendingRequests.get(key);
        }

        // Create a new request promise
        const promise = new Promise((resolve, reject) => {
            this.queue.push({ url, key, resolve, reject });
            this.processQueue();
        });

        this.pendingRequests.set(key, promise);

        try {
            const texture = await promise;
            this.cache.set(key, {
                texture,
                timestamp: Date.now(),
                refCount: 1 // Initial ref
            });
            this.pendingRequests.delete(key);
            this.enforceLimits();
            return texture;
        } catch (e) {
            this.pendingRequests.delete(key);
            throw e;
        }
    }

    processQueue() {
        if (this.activeRequests >= this.concurrency || this.queue.length === 0) {
            return;
        }

        const { url, key, resolve, reject } = this.queue.shift();
        this.activeRequests++;

        this.textureLoader.load(
            url,
            (texture) => {
                this.activeRequests--;
                resolve(texture);
                this.processQueue();
            },
            undefined,
            (err) => {
                this.activeRequests--;
                console.error(`Failed to load tile: ${url}`, err);
                reject(err);
                this.processQueue();
            }
        );
    }

    enforceLimits() {
        if (this.cache.size <= this.maxEntries) return;

        // Simple LRU eviction
        // Sort by timestamp
        const entries = Array.from(this.cache.entries());
        entries.sort((a, b) => a[1].timestamp - b[1].timestamp);

        // Remove oldest
        while (this.cache.size > this.maxEntries) {
            const [key, entry] = entries.shift();
            entry.texture.dispose();
            this.cache.delete(key);
        }
    }

    clear() {
        this.cache.forEach(entry => entry.texture.dispose());
        this.cache.clear();
    }
}
