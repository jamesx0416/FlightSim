import * as THREE from "three";
import { AtmosphereMaterial } from "./AtmosphereMaterial.js";

/**
 * Manages the atmospheric sky rendering using a full-screen quad.
 * This approach is more robust than a sky dome sphere.
 * 
 * Inspired by three-geospatial's atmosphere package implementation.
 */
export class Atmosphere {
  /**
   * @param {THREE.Scene} scene - The scene to add atmosphere to
   * @param {THREE.Camera} camera - The camera for updating material
   */
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    
    /** @type {THREE.Vector3} Sun direction vector */
    this.sunDirection = new THREE.Vector3(1, 0.3, 0);
    
    // Create the atmosphere material
    this.material = new AtmosphereMaterial({
      sunDirection: this.sunDirection,
      sunIntensity: 22.0
    });
    
    // Create a full-screen quad (2x2 plane in clip space)
    // The vertex shader positions this to cover the entire screen
    this.geometry = new THREE.PlaneGeometry(2, 2);
    
    // Create the sky mesh
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false; // Always render
    this.mesh.renderOrder = -1000; // Render first (background)
    
    // Add to scene
    this.scene.add(this.mesh);
  }

  /**
   * Updates the atmosphere for the current frame.
   * Should be called every frame before rendering.
   * 
   * @param {THREE.Vector3} sunDirection - Current sun direction
   */
  update(sunDirection) {
    // Update sun direction
    if (sunDirection) {
      this.sunDirection.copy(sunDirection);
      this.material.setSunDirection(this.sunDirection);
    }
    
    // Update camera matrices
    this.material.setCameraPosition(this.camera.position);
    this.material.setInverseProjectionMatrix(this.camera.projectionMatrixInverse);
    this.material.setInverseViewMatrix(this.camera.matrixWorld);
  }

  /**
   * Sets the sun intensity.
   * @param {number} intensity
   */
  setSunIntensity(intensity) {
    this.material.setSunIntensity(intensity);
  }

  /**
   * Gets the atmosphere mesh for custom manipulation.
   * @returns {THREE.Mesh}
   */
  getMesh() {
    return this.mesh;
  }

  /**
   * Gets the atmosphere material for custom manipulation.
   * @returns {AtmosphereMaterial}
   */
  getMaterial() {
    return this.material;
  }

  /**
   * Disposes of all resources.
   */
  dispose() {
    this.geometry.dispose();
    this.material.dispose();
    this.scene.remove(this.mesh);
  }
}
