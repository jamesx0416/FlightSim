import * as THREE from "three";
import { RADIUS, SUN_DISTANCE, SUN_ANGULAR_RADIUS } from "../Constants.js";

/**
 * Manages sun position, direction, and visual representation.
 * Inspired by three-geospatial's celestial direction calculations.
 */
export class SunManager {
  /**
   * @param {THREE.Scene} scene - The scene to add sun visuals to
   * @param {THREE.DirectionalLight} sunLight - The directional light representing the sun
   */
  constructor(scene, sunLight) {
    this.scene = scene;
    this.sunLight = sunLight;
    
    /** @type {THREE.Vector3} Normalized direction to the sun in world coordinates */
    this.sunDirection = new THREE.Vector3(1, 0, 0);
    
    /** @type {number} Current sun angle in radians */
    this.angle = 0;
    
    /** @type {number} Angular radius of the sun for rendering */
    this.angularRadius = SUN_ANGULAR_RADIUS;
    
    // Create visual sun mesh (emissive sphere)
    this._createSunMesh();
  }

  /**
   * Creates the visual sun mesh.
   * @private
   */
  _createSunMesh() {
    // Sun is rendered as a bright emissive sphere
    const sunGeometry = new THREE.SphereGeometry(RADIUS * 0.5, 32, 32);
    const sunMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffee,
      fog: false
    });
    
    this.sunMesh = new THREE.Mesh(sunGeometry, sunMaterial);
    this.sunMesh.position.copy(this.sunLight.position);
    this.sunMesh.renderOrder = 1000; // Render after atmosphere
    this.scene.add(this.sunMesh);
  }

  /**
   * Updates sun position based on a simple orbital model.
   * 
   * @param {number} deltaTime - Time elapsed since last frame (ms)
   * @param {number} speed - Day cycle speed multiplier
   */
  update(deltaTime, speed) {
    this.angle += speed * deltaTime;
    
    // Calculate sun position on orbital path
    const x = Math.cos(this.angle) * SUN_DISTANCE;
    const z = Math.sin(this.angle) * SUN_DISTANCE;
    // Add slight tilt for seasonal variation effect
    const y = Math.sin(this.angle * 0.1) * SUN_DISTANCE * 0.3;
    
    // Update light position
    this.sunLight.position.set(x, y, z);
    
    // Update normalized direction (from origin toward sun)
    this.sunDirection.copy(this.sunLight.position).normalize();
    
    // Update visual mesh position
    this.sunMesh.position.copy(this.sunLight.position);
  }

  /**
   * Sets sun direction from a specific date/time.
   * Simplified solar position calculation.
   * 
   * @param {Date} date - The date/time to calculate sun position for
   */
  updateByDate(date) {
    // Simplified solar position calculation
    // In a full implementation, this would use astronomical calculations
    // like those in astronomy-engine used by three-geospatial
    
    const dayOfYear = this._getDayOfYear(date);
    const hourAngle = (date.getUTCHours() + date.getUTCMinutes() / 60) / 24 * Math.PI * 2;
    
    // Solar declination (simplified)
    const declination = 23.45 * Math.sin((2 * Math.PI / 365) * (dayOfYear - 81)) * (Math.PI / 180);
    
    // Calculate sun direction
    const x = Math.cos(hourAngle);
    const y = Math.sin(declination);
    const z = Math.sin(hourAngle) * Math.cos(declination);
    
    this.sunDirection.set(x, y, z).normalize();
    this.sunLight.position.copy(this.sunDirection).multiplyScalar(SUN_DISTANCE);
    this.sunMesh.position.copy(this.sunLight.position);
  }

  /**
   * @private
   */
  _getDayOfYear(date) {
    const start = new Date(date.getFullYear(), 0, 0);
    const diff = date - start;
    const oneDay = 1000 * 60 * 60 * 24;
    return Math.floor(diff / oneDay);
  }

  /**
   * Gets sun direction for use in atmosphere shaders.
   * @returns {THREE.Vector3}
   */
  getDirection() {
    return this.sunDirection;
  }

  /**
   * Disposes of resources.
   */
  dispose() {
    this.sunMesh.geometry.dispose();
    this.sunMesh.material.dispose();
    this.scene.remove(this.sunMesh);
  }
}
