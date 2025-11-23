import * as THREE from "https://cdnjs.cloudflare.com/ajax/libs/three.js/0.180.0/three.module.min.js";

export class TileCache {
    constructor(capacity = 500, onEvict = null) {
        this.capacity = capacity;
        this.onEvict = onEvict;
        this.map = new Map(); // key -> { tile, lastUsed }
        this.head = null; // MRU
        this.tail = null; // LRU
    }

    get(key) {
        if (this.map.has(key)) {
            const node = this.map.get(key);
            this.promote(node);
            return node.value;
        }
        return null;
    }

    add(key, value) {
        if (this.map.has(key)) {
            const node = this.map.get(key);
            node.value = value;
            this.promote(node);
        } else {
            const node = { key, value, prev: null, next: null };
            this.map.set(key, node);
            this.addToHead(node);
            this.trim();
        }
    }

    promote(node) {
        if (node === this.head) return;
        this.removeNode(node);
        this.addToHead(node);
    }

    addToHead(node) {
        node.next = this.head;
        node.prev = null;
        if (this.head) this.head.prev = node;
        this.head = node;
        if (!this.tail) this.tail = node;
    }

    removeNode(node) {
        if (node.prev) node.prev.next = node.next;
        else this.head = node.next;

        if (node.next) node.next.prev = node.prev;
        else this.tail = node.prev;
    }

    trim() {
        while (this.map.size > this.capacity) {
            this.evictLRU();
        }
    }

    evictLRU() {
        if (!this.tail) return;
        const node = this.tail;
        this.removeNode(node);
        this.map.delete(node.key);

        // Notify caller to remove from scene
        if (this.onEvict) {
            this.onEvict(node.value);
        }

        // Dispose resources if applicable
        if (node.value) {
            if (node.value.geometry) node.value.geometry.dispose();
            if (node.value.material) {
                if (node.value.material.map) node.value.material.map.dispose();
                node.value.material.dispose();
            }
        }
    }

    size() {
        return this.map.size;
    }
}
