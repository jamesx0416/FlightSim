export class Profiler {
    constructor() {
        this.overlay = document.getElementById('debug-overlay');
        this.frameCount = 0;
        this.lastTime = performance.now();
        this.fps = 0;
        this.stats = {
            zoom: 0,
            tilesLoaded: 0,
            activeRequests: 0,
            memory: 'N/A'
        };
    }

    update(stats = {}) {
        this.frameCount++;
        const now = performance.now();
        if (now - this.lastTime >= 1000) {
            this.fps = this.frameCount;
            this.frameCount = 0;
            this.lastTime = now;
        }

        Object.assign(this.stats, stats);

        if (this.overlay) {
            this.overlay.innerHTML = `
                FPS: ${this.fps}<br>
                Zoom: ${this.stats.zoom}<br>
                Tiles: ${this.stats.tilesLoaded}<br>
                Loading: ${this.stats.activeRequests}<br>
                GPU Mem: ${this.stats.memory}
            `;
        }
    }
}
