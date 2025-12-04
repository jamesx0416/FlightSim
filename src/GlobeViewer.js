// src/GlobeViewer.js
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONFIG } from '../config.js';

export class GlobeViewer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);

        // Scene
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x000000); // Space black

        // Camera
        this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 100, 50000000);
        this.camera.position.set(0, 0, 20000000);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: true });
        this.renderer.setSize(window.innerWidth, window.innerHeight);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.container.appendChild(this.renderer.domElement);

        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.minDistance = 6378137 + 100; // Surface + 100m
        this.controls.maxDistance = 50000000;
        this.controls.enablePan = false;

        // Lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
        dirLight.position.set(1, 1, 1);
        this.scene.add(dirLight);

        // Base Globe
        this.createBaseGlobe();

        // Resize Handler
        window.addEventListener('resize', this.onWindowResize.bind(this));
    }

    createBaseGlobe() {
        const radius = 6378137;
        const geometry = new THREE.SphereGeometry(radius, 64, 64);

        // Simple texture loader
        const loader = new THREE.TextureLoader();
        const texture = loader.load(CONFIG.FALLBACK_IMAGERY_URL);

        const material = new THREE.MeshPhongMaterial({
            map: texture,
            specular: 0x111111,
            shininess: 5
        });

        this.globe = new THREE.Mesh(geometry, material);

        this.scene.add(this.globe);
    }

    setBaseGlobeVisible(visible) {
        if (this.globe) {
            this.globe.visible = visible;
        }
    }

    onWindowResize() {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
    }

    render() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}
