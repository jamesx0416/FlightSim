// src/DebugOverlay.js
export class DebugOverlay {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.element = document.createElement('div');
        this.element.style.position = 'absolute';
        this.element.style.top = '10px';
        this.element.style.left = '10px';
        this.element.style.color = '#0f0';
        this.element.style.backgroundColor = 'rgba(0, 0, 0, 0.7)';
        this.element.style.padding = '10px';
        this.element.style.fontFamily = 'monospace';
        this.element.style.pointerEvents = 'none';
        this.element.style.zIndex = '1000';
        this.container.appendChild(this.element);

        this.stats = {
            fps: 0,
            tilesLoaded: 0,
            tilesVisible: 0,
            cacheSize: 0,
            altitude: 0,
            message: ''
        };

        this.lastTime = performance.now();
        this.frameCount = 0;
    }

    update(info) {
        // Update FPS
        this.frameCount++;
        const now = performance.now();
        if (now - this.lastTime >= 1000) {
            this.stats.fps = this.frameCount;
            this.frameCount = 0;
            this.lastTime = now;
        }

        // Merge info
        if (info) {
            Object.assign(this.stats, info);
        }

        this.render();
    }

    render() {
        this.element.innerHTML = `
            <div>FPS: ${this.stats.fps}</div>
            <div>Tiles Loaded: ${this.stats.tilesLoaded}</div>
            <div>Tiles Visible: ${this.stats.tilesVisible}</div>
            <div>Cache Size: ${this.stats.cacheSize}</div>
            <div>Altitude: ${Math.round(this.stats.altitude)} m</div>
            <div style="color: #ff4444">${this.stats.message}</div>
        `;
    }

    logError(msg) {
        this.stats.message = msg;
        this.render();
        setTimeout(() => {
            this.stats.message = '';
            this.render();
        }, 5000);
    }
}
