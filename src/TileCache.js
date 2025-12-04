// src/TileCache.js

export class TileCache {
    constructor(maxSize = 100) {
        this.maxSize = maxSize;
        this.cache = new Map(); // Key -> { item, lastAccess }
    }

    get(key) {
        if (this.cache.has(key)) {
            const entry = this.cache.get(key);
            entry.lastAccess = performance.now();
            return entry.item;
        }
        return null;
    }

    add(key, item) {
        if (this.cache.size >= this.maxSize) {
            this.evict();
        }
        this.cache.set(key, { item, lastAccess: performance.now() });
    }

    evict() {
        // Simple LRU eviction
        let oldestKey = null;
        let oldestTime = Infinity;

        for (const [key, entry] of this.cache.entries()) {
            if (entry.lastAccess < oldestTime) {
                oldestTime = entry.lastAccess;
                oldestKey = key;
            }
        }

        if (oldestKey) {
            const entry = this.cache.get(oldestKey);
            this.disposeItem(entry.item);
            this.cache.delete(oldestKey);
        }
    }

    disposeItem(item) {
        if (item.isMesh) {
            if (item.geometry) item.geometry.dispose();
            if (item.material) {
                if (Array.isArray(item.material)) {
                    item.material.forEach(m => this.disposeMaterial(m));
                } else {
                    this.disposeMaterial(item.material);
                }
            }
        } else if (item.dispose) {
            item.dispose();
        }
    }

    disposeMaterial(material) {
        if (material.map) material.map.dispose();
        material.dispose();
    }

    getSize() {
        return this.cache.size;
    }
}
