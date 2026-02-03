import * as THREE from "three";
import {
  RADIUS,
  ATMOSPHERE_TOP_RADIUS,
  ATMOSPHERE_SCALE_HEIGHT_RAYLEIGH,
  ATMOSPHERE_SCALE_HEIGHT_MIE,
  RAYLEIGH_SCATTERING,
  MIE_SCATTERING,
  MIE_ASYMMETRY,
  SUN_ANGULAR_RADIUS
} from "../Constants.js";

/**
 * Vertex shader for full-screen atmosphere rendering.
 */
const atmosphereVertexShader = /* glsl */ `
varying vec3 vRayDirection;

uniform mat4 inverseProjectionMatrix;
uniform mat4 inverseViewMatrix;

void main() {
  vec2 clipXY = position.xy;
  
  // Create clip space position
  vec4 clipPos = vec4(clipXY, 0.0, 1.0);
  
  // Transform to view space
  vec4 viewPos = inverseProjectionMatrix * clipPos;
  viewPos.xyz /= viewPos.w;
  
  // Transform direction to world space
  vec4 worldDir = inverseViewMatrix * vec4(viewPos.xyz, 0.0);
  vRayDirection = normalize(worldDir.xyz);
  
  gl_Position = vec4(clipXY, 0.0, 1.0);
}
`;

/**
 * Fragment shader implementing atmospheric scattering.
 */
const atmosphereFragmentShader = /* glsl */ `
uniform float bottomRadius;
uniform float topRadius;
uniform float scaleHeightRayleigh;
uniform float scaleHeightMie;
uniform vec3 rayleighScattering;
uniform float mieScattering;
uniform float mieAsymmetry;

uniform vec3 sunDirection;
uniform float sunAngularRadius;
uniform float sunIntensity;

uniform vec3 cameraPos;

varying vec3 vRayDirection;

#define PI 3.14159265359
#define PRIMARY_STEPS 12
#define LIGHT_STEPS 4

float phaseRayleigh(float cosTheta) {
  return 0.05968310365 * (1.0 + cosTheta * cosTheta);
}

float phaseMie(float cosTheta, float g) {
  float g2 = g * g;
  float num = (1.0 - g2);
  float denom = 4.0 * PI * pow(1.0 + g2 - 2.0 * g * cosTheta, 1.5);
  return num / denom;
}

vec2 raySphere(vec3 ro, vec3 rd, float radius) {
  float b = dot(ro, rd);
  float c = dot(ro, ro) - radius * radius;
  float d = b * b - c;
  if (d < 0.0) return vec2(-1.0, -1.0);
  d = sqrt(d);
  return vec2(-b - d, -b + d);
}

vec2 getDensity(float altitude) {
  return vec2(
    exp(-altitude / scaleHeightRayleigh),
    exp(-altitude / scaleHeightMie)
  );
}

vec2 opticalDepth(vec3 ro, vec3 rd, float len) {
  float stepLen = len / float(LIGHT_STEPS);
  vec2 depth = vec2(0.0);
  for (int i = 0; i < LIGHT_STEPS; i++) {
    vec3 p = ro + rd * (float(i) + 0.5) * stepLen;
    float alt = length(p) - bottomRadius;
    depth += getDensity(alt) * stepLen;
  }
  return depth;
}

vec3 atmosphere(vec3 ro, vec3 rd, vec3 sunDir) {
  vec2 atmos = raySphere(ro, rd, topRadius);
  if (atmos.y < 0.0) return vec3(0.0);
  
  vec2 planet = raySphere(ro, rd, bottomRadius);
  float tStart = max(0.0, atmos.x);
  float tEnd = atmos.y;
  
  if (planet.x > 0.0) {
    tEnd = min(tEnd, planet.x);
  }
  
  float rayLen = tEnd - tStart;
  if (rayLen <= 0.0) return vec3(0.0);
  
  float stepLen = rayLen / float(PRIMARY_STEPS);
  vec3 sumR = vec3(0.0);
  vec3 sumM = vec3(0.0);
  vec2 optDepth = vec2(0.0);
  
  float cosTheta = dot(rd, sunDir);
  float phaseR = phaseRayleigh(cosTheta);
  float phaseM = phaseMie(cosTheta, mieAsymmetry);
  
  for (int i = 0; i < PRIMARY_STEPS; i++) {
    vec3 p = ro + rd * (tStart + (float(i) + 0.5) * stepLen);
    float alt = length(p) - bottomRadius;
    vec2 density = getDensity(alt);
    optDepth += density * stepLen;
    
    vec2 sunAtmos = raySphere(p, sunDir, topRadius);
    vec2 sunPlanet = raySphere(p, sunDir, bottomRadius);
    if (sunPlanet.x > 0.0) continue;
    
    vec2 sunOptDepth = opticalDepth(p, sunDir, sunAtmos.y);
    vec3 tau = rayleighScattering * (optDepth.x + sunOptDepth.x) +
               vec3(mieScattering * 1.1) * (optDepth.y + sunOptDepth.y);
    vec3 atten = exp(-tau);
    
    sumR += atten * density.x * stepLen;
    sumM += atten * density.y * stepLen;
  }
  
  return sunIntensity * (phaseR * rayleighScattering * sumR + phaseM * mieScattering * sumM);
}

vec3 renderSun(vec3 rd, vec3 sunDir, vec3 ro) {
  float cosAngle = dot(rd, sunDir);
  float angle = acos(clamp(cosAngle, -1.0, 1.0));
  if (angle < sunAngularRadius * 4.0) {
    vec2 planet = raySphere(ro, rd, bottomRadius);
    if (planet.x > 0.0) return vec3(0.0);
    float intensity = smoothstep(sunAngularRadius * 2.0, sunAngularRadius * 0.5, angle);
    return vec3(1.0, 0.96, 0.9) * sunIntensity * 0.1 * intensity;
  }
  return vec3(0.0);
}

void main() {
  vec3 rd = normalize(vRayDirection);
  vec3 ro = cameraPos;
  vec3 sunDir = normalize(sunDirection);
  
  vec3 color = atmosphere(ro, rd, sunDir);
  color += renderSun(rd, sunDir, ro);
  
  // Inverse Atmosphere Logic:
  // Determine if we are looking at the planet
  vec2 planet = raySphere(ro, rd, bottomRadius);
  bool hitPlanet = planet.x > 0.0 && planet.x < planet.y;
  
  // Calculate camera altitude for fade effect
  float altitude = length(ro) - bottomRadius;
  float altitudeFactor = clamp(altitude / 100000.0, 0.0, 1.0); // Fade out below 100km
  
  float alpha;
  if (hitPlanet) {
    // We are looking at Earth through the atmosphere.
    // At night (sun is blocked by Earth), we want it to be OPAQUE BLACK.
    // At day, we want it to be TRANSPARENT BLUE.
    
    vec3 hitPos = ro + rd * planet.x;
    vec3 normal = normalize(hitPos);
    float sunVisibility = clamp(dot(normal, sunDir) * 2.0, 0.0, 1.0);
    
    // Day side: Alpha tied to scattering intensity
    // Night side: Alpha = 1.0
    float scatteringIntensity = length(color);
    float atmosphereAlpha = mix(1.0, clamp(scatteringIntensity, 0.0, 0.8), sunVisibility);
    
    // Fade out atmosphere at low altitude so we can see tiles clearly
    alpha = atmosphereAlpha * altitudeFactor;
  } else {
    // Looking at sky/rim - fade out at low altitude
    alpha = clamp(length(color), 0.0, 1.0) * altitudeFactor;
  }
  
  // Tone mapping
  color = 1.0 - exp(-color * 0.5);
  // Gamma
  color = pow(color, vec3(0.4545));
  
  gl_FragColor = vec4(color, alpha);
}
`;

export class AtmosphereMaterial extends THREE.ShaderMaterial {
  constructor(options = {}) {
    const {
      sunDirection = new THREE.Vector3(1, 0.3, 0),
      sunIntensity = 20.0
    } = options;

    super({
      vertexShader: atmosphereVertexShader,
      fragmentShader: atmosphereFragmentShader,
      uniforms: {
        bottomRadius: { value: RADIUS },
        topRadius: { value: ATMOSPHERE_TOP_RADIUS },
        scaleHeightRayleigh: { value: ATMOSPHERE_SCALE_HEIGHT_RAYLEIGH },
        scaleHeightMie: { value: ATMOSPHERE_SCALE_HEIGHT_MIE },
        rayleighScattering: { value: new THREE.Vector3(...RAYLEIGH_SCATTERING) },
        mieScattering: { value: MIE_SCATTERING },
        mieAsymmetry: { value: MIE_ASYMMETRY },
        sunDirection: { value: sunDirection.clone().normalize() },
        sunAngularRadius: { value: SUN_ANGULAR_RADIUS },
        sunIntensity: { value: sunIntensity },
        cameraPos: { value: new THREE.Vector3() },
        inverseProjectionMatrix: { value: new THREE.Matrix4() },
        inverseViewMatrix: { value: new THREE.Matrix4() }
      },
      side: THREE.FrontSide,
      depthTest: false,
      depthWrite: false,
      transparent: true
    });
  }

  setSunDirection(direction) {
    this.uniforms.sunDirection.value.copy(direction).normalize();
  }

  setCameraPosition(position) {
    this.uniforms.cameraPos.value.copy(position);
  }

  setInverseProjectionMatrix(matrix) {
    this.uniforms.inverseProjectionMatrix.value.copy(matrix);
  }

  setInverseViewMatrix(matrix) {
    this.uniforms.inverseViewMatrix.value.copy(matrix);
  }

  setSunIntensity(intensity) {
    this.uniforms.sunIntensity.value = intensity;
  }
}
