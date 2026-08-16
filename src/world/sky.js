// Weather presets, sky dome, lighting rig, distant peaks and precipitation.
// A preset is the single source of truth for the mood of a map: every light,
// fog value and particle in the scene is derived from it.

import * as THREE from 'three';
import { Noise2D, clamp, lerp } from '../core/math.js';

const deg = (d) => (d * Math.PI) / 180;

export const WEATHER = {
  bluebird: {
    name: 'Bluebird',
    skyTop: 0x1f5fbf, skyMid: 0x7fb4e8, skyHorizon: 0xdceaf7,
    sunElev: 42, sunAzim: 140, sunColor: 0xfff6e0, sunIntensity: 2.15,
    ambient: 0x9fc0e8, ambientIntensity: 0.55,
    ground: 0xdfe9f5, hemiIntensity: 0.75,
    fog: { color: 0xcadff2, near: 500, far: 3600 },
    precip: null, wind: 0.35, sparkle: 1.0, exposure: 1.02,
  },
  overcast: {
    name: 'Overcast',
    skyTop: 0x8c97a6, skyMid: 0xb3bcc7, skyHorizon: 0xd8dde3,
    sunElev: 55, sunAzim: 190, sunColor: 0xdfe4ec, sunIntensity: 0.85,
    ambient: 0xc0c8d4, ambientIntensity: 1.0,
    ground: 0xd6dbe2, hemiIntensity: 1.0,
    fog: { color: 0xc6ccd4, near: 240, far: 2100 },
    precip: null, wind: 0.5, sparkle: 0.15, exposure: 1.0,
    snowShine: 8, snowSpec: 0x1a1f26,
  },
  alpine: {
    name: 'High Alpine',
    skyTop: 0x0d3f95, skyMid: 0x4d8ed6, skyHorizon: 0xc4dcf0,
    sunElev: 34, sunAzim: 120, sunColor: 0xfff2d6, sunIntensity: 2.4,
    ambient: 0x86aede, ambientIntensity: 0.5,
    ground: 0xdce8f6, hemiIntensity: 0.7,
    fog: { color: 0xbcd6ee, near: 700, far: 4600 },
    precip: { type: 'snow', rate: 0.12, size: 0.7 }, wind: 0.9, sparkle: 1.3, exposure: 1.04,
  },
  flurries: {
    name: 'Light Snow',
    skyTop: 0x76839a, skyMid: 0x9fabbc, skyHorizon: 0xcdd4dc,
    sunElev: 48, sunAzim: 200, sunColor: 0xd8dfe8, sunIntensity: 0.7,
    ambient: 0xb8c2d0, ambientIntensity: 1.05,
    ground: 0xd2d8e0, hemiIntensity: 1.0,
    fog: { color: 0xbec6d0, near: 140, far: 1500 },
    precip: { type: 'snow', rate: 0.55, size: 1.0 }, wind: 0.7, sparkle: 0.2, exposure: 1.0,
    snowShine: 6, snowSpec: 0x161a20,
  },
  powderday: {
    name: 'Powder Day',
    skyTop: 0x6b7a92, skyMid: 0x97a5b8, skyHorizon: 0xd4dae1,
    sunElev: 50, sunAzim: 175, sunColor: 0xe4e9f0, sunIntensity: 0.75,
    ambient: 0xbcc6d4, ambientIntensity: 1.1,
    ground: 0xd8dee6, hemiIntensity: 1.05,
    fog: { color: 0xc2cad4, near: 120, far: 1200 },
    precip: { type: 'snow', rate: 0.95, size: 1.35 }, wind: 0.45, sparkle: 0.35, exposure: 1.0,
    snowShine: 5, snowSpec: 0x14181e,
  },
  storm: {
    name: 'Storm',
    skyTop: 0x39404d, skyMid: 0x5a6270, skyHorizon: 0x8a929c,
    sunElev: 60, sunAzim: 210, sunColor: 0x9aa3b0, sunIntensity: 0.45,
    ambient: 0x7e8794, ambientIntensity: 1.0,
    ground: 0x9aa2ad, hemiIntensity: 0.9,
    fog: { color: 0x8d959f, near: 60, far: 620, exp: 0.0021 },
    precip: { type: 'snow', rate: 1.6, size: 1.1, chaos: 2.2 }, wind: 2.4, sparkle: 0, exposure: 0.98,
    snowShine: 4, snowSpec: 0x101318,
  },
  whiteout: {
    name: 'Whiteout',
    skyTop: 0xc8ced6, skyMid: 0xd6dbe1, skyHorizon: 0xe2e6ea,
    sunElev: 70, sunAzim: 180, sunColor: 0xeef1f5, sunIntensity: 0.5,
    ambient: 0xdde2e8, ambientIntensity: 1.35,
    ground: 0xe4e8ec, hemiIntensity: 1.3,
    fog: { color: 0xdfe4e9, near: 20, far: 260, exp: 0.0072 },
    precip: { type: 'snow', rate: 1.9, size: 0.9, chaos: 2.8 }, wind: 2.8, sparkle: 0, exposure: 1.0,
    snowShine: 2, snowSpec: 0x0d0f12,
  },
  dusk: {
    name: 'Dusk',
    skyTop: 0x1c2a52, skyMid: 0x6a5a8c, skyHorizon: 0xe8956a,
    sunElev: 5, sunAzim: 255, sunColor: 0xffb277, sunIntensity: 1.5,
    ambient: 0x6478a8, ambientIntensity: 0.6,
    ground: 0xa8a2bb, hemiIntensity: 0.6,
    fog: { color: 0xa88ba0, near: 300, far: 2600 },
    precip: null, wind: 0.4, sparkle: 0.7, exposure: 1.05, stars: 0.35,
  },
  sunrise: {
    name: 'Sunrise',
    skyTop: 0x21418c, skyMid: 0x8f8fc0, skyHorizon: 0xffc48a,
    sunElev: 9, sunAzim: 95, sunColor: 0xffd0a0, sunIntensity: 1.75,
    ambient: 0x7f92c4, ambientIntensity: 0.6,
    ground: 0xd0cbd8, hemiIntensity: 0.7,
    fog: { color: 0xdcbba8, near: 350, far: 3000 },
    precip: null, wind: 0.25, sparkle: 1.2, exposure: 1.05, stars: 0.15,
  },
  goldenhour: {
    name: 'Golden Hour',
    skyTop: 0x2a5896, skyMid: 0x93aed2, skyHorizon: 0xffd9a8,
    sunElev: 14, sunAzim: 250, sunColor: 0xffdaa8, sunIntensity: 2.0,
    ambient: 0x93a8cc, ambientIntensity: 0.55,
    ground: 0xe8dcc8, hemiIntensity: 0.7,
    fog: { color: 0xe6c7a4, near: 420, far: 3400 },
    precip: null, wind: 0.3, sparkle: 1.4, exposure: 1.04,
  },
  moonlight: {
    name: 'Moonlight',
    skyTop: 0x040a1c, skyMid: 0x0d1a38, skyHorizon: 0x27385c,
    sunElev: 52, sunAzim: 300, sunColor: 0xa8c4ff, sunIntensity: 0.62,
    ambient: 0x24406e, ambientIntensity: 0.55,
    ground: 0x35486a, hemiIntensity: 0.5,
    fog: { color: 0x16233d, near: 90, far: 900 },
    precip: { type: 'snow', rate: 0.2, size: 0.9 }, wind: 0.4, sparkle: 0.6, exposure: 1.15,
    stars: 1.0, moon: true, snowShine: 44, snowSpec: 0x3a4a6e,
  },
  // A floodlit hill at night is genuinely bright — the snow throws the lamps
  // straight back at you. Much more ambient lift than `nightpark`, which is
  // tuned for a dark park with a few feature lights.
  nightresort: {
    name: 'Night Skiing',
    skyTop: 0x070d20, skyMid: 0x172542, skyHorizon: 0x444a5e,
    sunElev: 58, sunAzim: 290, sunColor: 0xb6c8e6, sunIntensity: 0.5,
    ambient: 0x455470, ambientIntensity: 1.15,
    ground: 0x66718a, hemiIntensity: 1.0,
    fog: { color: 0x2a3348, near: 130, far: 1200 },
    precip: { type: 'snow', rate: 0.45, size: 1.0 }, wind: 0.35, sparkle: 0.8, exposure: 1.16,
    stars: 0.55, snowShine: 34, snowSpec: 0x3d4d70,
  },
  nightpark: {
    name: 'Night Park',
    skyTop: 0x05091a, skyMid: 0x101c33, skyHorizon: 0x2b3346,
    sunElev: 60, sunAzim: 280, sunColor: 0x9ab0d8, sunIntensity: 0.3,
    ambient: 0x2a3550, ambientIntensity: 0.6,
    ground: 0x3d4658, hemiIntensity: 0.5,
    fog: { color: 0x1a2233, near: 80, far: 780 },
    precip: { type: 'snow', rate: 0.35, size: 1.0 }, wind: 0.5, sparkle: 0.5, exposure: 1.2,
    stars: 0.8, snowShine: 30, snowSpec: 0x30405e,
  },
  // Above 8,000 m there is a third of the atmosphere left to scatter light.
  // The zenith goes almost black, the sun is unfiltered and brutal, shadows
  // are hard, and you can see a hundred kilometres. Nothing else in the game
  // should look like this.
  deathzone: {
    name: 'Death Zone',
    skyTop: 0x02040f, skyMid: 0x0b2a63, skyHorizon: 0x7fb0dd,
    sunElev: 38, sunAzim: 110, sunColor: 0xfffdf4, sunIntensity: 3.1,
    ambient: 0x5f86bd, ambientIntensity: 0.42,
    ground: 0xe8f2ff, hemiIntensity: 0.55,
    fog: { color: 0xa8c8e8, near: 2200, far: 14000 },
    precip: { type: 'snow', rate: 0.5, size: 0.5, chaos: 3.2 },
    wind: 3.0, sparkle: 1.9, exposure: 1.05, stars: 0.22,
    snowShine: 74, snowSpec: 0x6f93c4,
  },
  // The Lhotse Face is a west-facing wall of blue ice that spends the morning
  // in shadow. Low raking light is what makes ice read as ice rather than as
  // pale snow, so the sun sits near the ridgeline and the fill goes cold.
  lhotse: {
    name: 'Lhotse Face',
    skyTop: 0x061031, skyMid: 0x18437f, skyHorizon: 0x9cc2e2,
    sunElev: 17, sunAzim: 265, sunColor: 0xfff0dc, sunIntensity: 2.5,
    ambient: 0x5878ac, ambientIntensity: 0.5,
    ground: 0xcfe2f8, hemiIntensity: 0.6,
    fog: { color: 0x9fbfdf, near: 1400, far: 9000 },
    precip: { type: 'snow', rate: 0.3, size: 0.45, chaos: 2.6 },
    wind: 2.4, sparkle: 1.7, exposure: 1.04, stars: 0.12,
    snowShine: 96, snowSpec: 0x7fa8d8,
  },
  // The Western Cwm is called the Valley of Silence. Walled in by Everest,
  // Lhotse and Nuptse, windless, and so reflective it acts as a solar oven —
  // it can hit 35°C at 6,500 m. Hard high sun, no wind, glare off everything.
  cwm: {
    name: 'Valley of Silence',
    skyTop: 0x0a2a72, skyMid: 0x3d78bf, skyHorizon: 0xd8e8f6,
    sunElev: 66, sunAzim: 165, sunColor: 0xfffcf0, sunIntensity: 3.0,
    ambient: 0xbcd4ee, ambientIntensity: 0.85,
    ground: 0xf2f8ff, hemiIntensity: 1.0,
    fog: { color: 0xcfe2f4, near: 1800, far: 11000 },
    precip: null, wind: 0.12, sparkle: 2.1, exposure: 1.02,
    snowShine: 52, snowSpec: 0x7c9ec8,
  },
  // The Khumbu Icefall is crossed before dawn, because the ice only holds
  // still while it's cold. First light is on the summits above; the icefall
  // itself is in deep blue shadow for another hour.
  khumbu: {
    name: 'Before Dawn',
    skyTop: 0x040a26, skyMid: 0x14356e, skyHorizon: 0xd08a5e,
    sunElev: 3, sunAzim: 95, sunColor: 0xffcf9a, sunIntensity: 1.35,
    ambient: 0x3c5a92, ambientIntensity: 0.85,
    ground: 0x8aa2c8, hemiIntensity: 0.8,
    fog: { color: 0x35507f, near: 500, far: 4200 },
    precip: { type: 'snow', rate: 0.18, size: 0.6 },
    wind: 0.5, sparkle: 1.1, exposure: 1.12, stars: 0.5,
    snowShine: 66, snowSpec: 0x54749f,
  },
  glacier: {
    name: 'Glacier',
    skyTop: 0x0a3a8f, skyMid: 0x4a8ed0, skyHorizon: 0xd2e6f5,
    sunElev: 28, sunAzim: 155, sunColor: 0xfffaf0, sunIntensity: 2.6,
    ambient: 0x8fb8e4, ambientIntensity: 0.6,
    ground: 0xe2eefa, hemiIntensity: 0.85,
    fog: { color: 0xcfe4f6, near: 900, far: 6000 },
    precip: { type: 'snow', rate: 0.08, size: 0.6 }, wind: 1.4, sparkle: 1.6, exposure: 1.06,
    snowShine: 60, snowSpec: 0x4a6f9e,
  },
  ashfall: {
    name: 'Ashfall',
    skyTop: 0x3a2a2a, skyMid: 0x6b5450, skyHorizon: 0xa88a72,
    sunElev: 22, sunAzim: 230, sunColor: 0xffb488, sunIntensity: 1.1,
    ambient: 0x6d5a58, ambientIntensity: 0.85,
    ground: 0x8a7a72, hemiIntensity: 0.8,
    fog: { color: 0x8f7a6c, near: 150, far: 1500 },
    precip: { type: 'ash', rate: 0.8, size: 0.75, chaos: 1.2 }, wind: 1.1, sparkle: 0.1, exposure: 1.0,
    snowShine: 10, snowSpec: 0x241d1a,
  },
};

const _cA = new THREE.Color();
const _cB = new THREE.Color();
const mixHex = (a, b, f) => _cA.set(a).lerp(_cB.set(b), f).getHex();
const mixNum = (a, b, f) => a + (b - a) * f;

/**
 * Blend two weather presets.
 *
 * A single terrain can only have one sky, one fog and one light rig — but a
 * mountain 3.4 km tall genuinely does not have one sky. Everest starts in the
 * death zone where the atmosphere is too thin to scatter much of anything and
 * finishes in pre-dawn shadow on a glacier, and losing that progression was
 * the one real cost of merging the sections into a single map. So the presets
 * interpolate with height instead.
 */
export function blendPresets(a, b, f) {
  const out = {
    name: f < 0.5 ? a.name : b.name,
    skyTop: mixHex(a.skyTop, b.skyTop, f),
    skyMid: mixHex(a.skyMid, b.skyMid, f),
    skyHorizon: mixHex(a.skyHorizon, b.skyHorizon, f),
    sunColor: mixHex(a.sunColor, b.sunColor, f),
    ambient: mixHex(a.ambient, b.ambient, f),
    ground: mixHex(a.ground, b.ground, f),
    sunElev: mixNum(a.sunElev, b.sunElev, f),
    sunAzim: mixNum(a.sunAzim, b.sunAzim, f),
    sunIntensity: mixNum(a.sunIntensity, b.sunIntensity, f),
    ambientIntensity: mixNum(a.ambientIntensity, b.ambientIntensity, f),
    hemiIntensity: mixNum(a.hemiIntensity, b.hemiIntensity, f),
    wind: mixNum(a.wind, b.wind, f),
    sparkle: mixNum(a.sparkle ?? 1, b.sparkle ?? 1, f),
    exposure: mixNum(a.exposure ?? 1, b.exposure ?? 1, f),
    stars: mixNum(a.stars ?? 0, b.stars ?? 0, f),
    moon: f < 0.5 ? a.moon : b.moon,
    snowShine: mixNum(a.snowShine ?? 26, b.snowShine ?? 26, f),
    snowSpec: mixHex(a.snowSpec ?? 0x2b3648, b.snowSpec ?? 0x2b3648, f),
    fog: {
      color: mixHex(a.fog.color, b.fog.color, f),
      near: mixNum(a.fog.near ?? 200, b.fog.near ?? 200, f),
      far: mixNum(a.fog.far ?? 3000, b.fog.far ?? 3000, f),
    },
    // Precipitation can't cross-fade, so it switches at the midpoint.
    precip: f < 0.5 ? a.precip : b.precip,
  };
  return out;
}

/** Resolve a `weatherStops` list at normalised distance `t` down the run. */
export function presetAt(stops, t) {
  if (t <= stops[0].t) return WEATHER[stops[0].weather];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].t) {
      const a = stops[i - 1], b = stops[i];
      const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
      return blendPresets(WEATHER[a.weather], WEATHER[b.weather], f * f * (3 - 2 * f));
    }
  }
  return WEATHER[stops[stops.length - 1].weather];
}

/** Push a (possibly blended) preset into a live scene. */
export function applyPreset(preset, { sky, lighting, scene, renderer }) {
  const u = sky.material.uniforms;
  u.uTop.value.set(preset.skyTop);
  u.uMid.value.set(preset.skyMid);
  u.uHorizon.value.set(preset.skyHorizon);
  u.uSunColor.value.set(preset.sunColor);
  u.uStars.value = preset.stars;

  const el = (preset.sunElev * Math.PI) / 180;
  const az = (preset.sunAzim * Math.PI) / 180;
  sky.sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)).normalize();
  u.uSunDir.value.copy(sky.sunDir);

  lighting.sun.color.set(preset.sunColor);
  lighting.sun.intensity = preset.sunIntensity;
  lighting.hemi.color.set(preset.ambient);
  lighting.hemi.groundColor.set(preset.ground);
  lighting.hemi.intensity = preset.hemiIntensity * 0.62;
  lighting.amb.color.set(preset.ambient);
  lighting.amb.intensity = preset.ambientIntensity * 0.3;

  if (scene.fog) {
    scene.fog.color.set(preset.fog.color);
    if (scene.fog.near !== undefined) {
      scene.fog.near = preset.fog.near;
      scene.fog.far = preset.fog.far;
    }
  }
  renderer.toneMappingExposure = preset.exposure;
}

// ── sky dome ──────────────────────────────────────────────────────
const SKY_VERT = `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    gl_Position.z = gl_Position.w; // always at the far plane
  }
`;

const SKY_FRAG = `
  precision highp float;
  varying vec3 vDir;
  uniform vec3 uTop, uMid, uHorizon, uSunColor;
  uniform vec3 uSunDir;
  uniform float uStars, uMoon, uSunSize;

  float hash31(vec3 p) {
    p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }

  void main() {
    vec3 d = normalize(vDir);
    float h = clamp(d.y, -1.0, 1.0);

    // Two-stage gradient: horizon haze into mid sky into zenith.
    float t1 = smoothstep(-0.05, 0.28, h);
    float t2 = smoothstep(0.2, 0.85, h);
    vec3 col = mix(uHorizon, uMid, t1);
    col = mix(col, uTop, t2);

    if (uStars > 0.001) {
      vec3 cellPos = d * 260.0;
      vec3 cell = floor(cellPos);
      float r = hash31(cell);
      if (r > 0.9955) {
        vec3 offs = fract(cellPos) - 0.5;
        float star = 1.0 - smoothstep(0.0, 0.34, length(offs));
        float bright = (r - 0.9955) / 0.0045;
        col += star * bright * uStars * smoothstep(0.0, 0.25, h) * 1.4;
      }
    }

    float sd = dot(d, uSunDir);
    if (uMoon > 0.5) {
      float disc = smoothstep(0.9988, 0.9994, sd);
      float halo = pow(max(sd, 0.0), 900.0) * 0.5 + pow(max(sd, 0.0), 40.0) * 0.06;
      col += uSunColor * (disc * 1.5 + halo);
    } else {
      float disc = smoothstep(1.0 - uSunSize * 1.4, 1.0 - uSunSize * 0.55, sd);
      float bloom = pow(max(sd, 0.0), 260.0) * 0.55 + pow(max(sd, 0.0), 14.0) * 0.13;
      col += uSunColor * (disc * 1.9 + bloom);
    }

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;

export class Sky {
  constructor(preset) {
    this.preset = preset;
    const geo = new THREE.SphereGeometry(1, 32, 20);
    this.sunDir = new THREE.Vector3();
    const el = deg(preset.sunElev), az = deg(preset.sunAzim);
    this.sunDir.set(
      Math.cos(el) * Math.sin(az),
      Math.sin(el),
      Math.cos(el) * Math.cos(az),
    ).normalize();

    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(preset.skyTop) },
        uMid: { value: new THREE.Color(preset.skyMid) },
        uHorizon: { value: new THREE.Color(preset.skyHorizon) },
        uSunColor: { value: new THREE.Color(preset.sunColor) },
        uSunDir: { value: this.sunDir.clone() },
        uStars: { value: preset.stars ?? 0 },
        uMoon: { value: preset.moon ? 1 : 0 },
        uSunSize: { value: 0.0016 },
      },
    });

    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    this.mesh.scale.setScalar(10);
  }

  update(camera) {
    this.mesh.position.copy(camera.position);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

// ── lighting rig ──────────────────────────────────────────────────
export function buildLighting(scene, preset, sunDir, extent) {
  const group = new THREE.Group();

  const sun = new THREE.DirectionalLight(preset.sunColor, preset.sunIntensity);
  sun.position.copy(sunDir).multiplyScalar(1200);
  sun.castShadow = true;
  const s = Math.min(extent * 0.5, 700);
  sun.shadow.camera.left = -s;
  sun.shadow.camera.right = s;
  sun.shadow.camera.top = s;
  sun.shadow.camera.bottom = -s;
  sun.shadow.camera.near = 200;
  sun.shadow.camera.far = 2600;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.bias = -0.0012;
  sun.shadow.normalBias = 1.2;
  group.add(sun);
  group.add(sun.target);

  // Fill is kept well below the key. Snow bounces a lot of light around, but
  // dialling the fill up to match washes out the form of the terrain, and on
  // an almost-white surface form is all you have to read the line ahead.
  const hemi = new THREE.HemisphereLight(
    preset.ambient, preset.ground, preset.hemiIntensity * 0.62,
  );
  group.add(hemi);

  const amb = new THREE.AmbientLight(preset.ambient, preset.ambientIntensity * 0.3);
  group.add(amb);

  scene.add(group);

  if (preset.fog?.exp) {
    scene.fog = new THREE.FogExp2(preset.fog.color, preset.fog.exp);
  } else {
    scene.fog = new THREE.Fog(preset.fog.color, preset.fog.near, preset.fog.far);
  }

  return { group, sun, hemi, amb };
}

// ── distant peaks ─────────────────────────────────────────────────
/**
 * A ring of silhouette mountains well outside the play area. Purely visual —
 * nothing ever collides with these — so they're a single low-poly mesh.
 */
/**
 * @param scale  Height of the skyline relative to alpine default. Not every
 *               mountain in this game is in the mountains — a Midwest hill
 *               wants rolling wooded ridges on the horizon, not the Alps.
 */
export function buildDistantPeaks(seed, preset, radius, baseY, scale = 1) {
  const noise = new Noise2D(seed ^ 0x77a1);
  const segments = 220;
  const rings = 5;
  const positions = [];
  const colors = [];
  const indices = [];

  const near = new THREE.Color(preset.skyHorizon).lerp(new THREE.Color(preset.ambient), 0.55);
  const far = new THREE.Color(preset.fog.color);

  for (let r = 0; r < rings; r++) {
    const rr = radius * (1 + r * 0.42);
    const layerT = r / (rings - 1);
    const heightScale = lerp(560, 1500, layerT) * scale;
    const col = near.clone().lerp(far, Math.pow(layerT, 0.65) * 0.85);

    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      const cx = Math.cos(a), cz = Math.sin(a);
      const n1 = noise.ridged(Math.cos(a) * 3.1 + r * 11, Math.sin(a) * 3.1, 4);
      const n2 = noise.fbm(Math.cos(a) * 7.7 + r * 5, Math.sin(a) * 7.7, 3);
      const peak = clamp(n1 * 0.7 + n2 * 0.45 + 0.35, 0.02, 1.4);

      // base vertex then peak vertex
      positions.push(cx * rr, baseY - 400, cz * rr);
      colors.push(col.r * 0.72, col.g * 0.74, col.b * 0.8);
      positions.push(cx * rr, baseY + peak * heightScale, cz * rr);
      colors.push(col.r, col.g, col.b);
    }

    const off = r * (segments + 1) * 2;
    for (let i = 0; i < segments; i++) {
      const a = off + i * 2;
      indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();

  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, fog: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -900;
  return mesh;
}

// ── precipitation ─────────────────────────────────────────────────
// aSize is a flake diameter in metres, projected to pixels properly:
// projectionMatrix[1][1] is 1/tan(fov/2), so half the viewport height times
// that, over distance, is exactly the pixels-per-metre at that depth. Sizing
// points by an arbitrary constant instead makes near flakes the size of
// tennis balls, which is what this replaced.
const PRECIP_VERT = `
  attribute float aSize;
  attribute float aPhase;
  uniform float uTime;
  uniform float uChaos;
  uniform float uViewportH;
  varying float vFade;
  void main() {
    vec3 p = position;
    p.x += sin(uTime * 1.7 + aPhase * 6.28) * uChaos * 1.6;
    p.y += sin(uTime * 0.9 + aPhase * 3.1) * 0.4;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float d = max(-mv.z, 0.05);
    vFade = smoothstep(0.35, 1.6, d) * (1.0 - smoothstep(45.0, 85.0, d));
    gl_Position = projectionMatrix * mv;
    float pxPerMetre = uViewportH * 0.5 * projectionMatrix[1][1] / d;
    gl_PointSize = clamp(aSize * pxPerMetre, 1.0, 26.0);
  }
`;

const PRECIP_FRAG = `
  precision mediump float;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = dot(c, c);
    if (d > 0.25) discard;
    float a = (1.0 - smoothstep(0.06, 0.25, d)) * vFade * uOpacity;
    gl_FragColor = vec4(uColor, a);
  }
`;

/**
 * Flakes live in a box that follows the camera; when one exits the box it
 * wraps to the opposite face. That keeps a constant, small particle count
 * regardless of how far you've skied.
 */
export class Precipitation {
  constructor(config, quality = 1) {
    this.config = config;
    this.box = new THREE.Vector3(90, 60, 90);
    const count = Math.floor(clamp(config.rate * 5200 * quality, 200, 9000));
    this.count = count;

    const pos = new Float32Array(count * 3);
    const size = new Float32Array(count);
    const phase = new Float32Array(count);
    this.vel = new Float32Array(count);

    // Flake diameters in metres. Real flakes are a few mm, but falling snow
    // clumps, and 2–7 cm is what actually reads on screen.
    const baseDiameter = (config.type === 'ash' ? 0.022 : 0.038) * config.size;
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this.box.x;
      pos[i * 3 + 1] = (Math.random() - 0.5) * this.box.y;
      pos[i * 3 + 2] = (Math.random() - 0.5) * this.box.z;
      size[i] = baseDiameter * (0.45 + Math.random() * 1.3);
      phase[i] = Math.random();
      this.vel[i] = 1.6 + Math.random() * 2.6;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 200);

    this.material = new THREE.ShaderMaterial({
      vertexShader: PRECIP_VERT,
      fragmentShader: PRECIP_FRAG,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uTime: { value: 0 },
        uChaos: { value: config.chaos ?? 0.6 },
        uColor: { value: new THREE.Color(config.type === 'ash' ? 0x4a4340 : 0xffffff) },
        uOpacity: { value: config.type === 'ash' ? 0.75 : 0.9 },
        uViewportH: { value: 800 },
      },
    });

    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.positions = pos;
  }

  update(dt, camera, windVec) {
    const p = this.positions;
    const b = this.box;
    const hx = b.x / 2, hy = b.y / 2, hz = b.z / 2;
    const wx = windVec.x * dt, wz = windVec.z * dt;

    for (let i = 0; i < this.count; i++) {
      const o = i * 3;
      p[o] += wx;
      p[o + 1] -= this.vel[i] * dt * 4.5;
      p[o + 2] += wz;

      if (p[o + 1] < -hy) { p[o + 1] += b.y; p[o] = (Math.random() - 0.5) * b.x; p[o + 2] = (Math.random() - 0.5) * b.z; }
      if (p[o] > hx) p[o] -= b.x; else if (p[o] < -hx) p[o] += b.x;
      if (p[o + 2] > hz) p[o + 2] -= b.z; else if (p[o + 2] < -hz) p[o + 2] += b.z;
    }

    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.position.copy(camera.position);
    this.material.uniforms.uTime.value += dt;
  }

  setViewportHeight(px) {
    this.material.uniforms.uViewportH.value = px;
  }

  dispose() {
    this.points.geometry.dispose();
    this.material.dispose();
  }
}
