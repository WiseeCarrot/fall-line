// Shared materials. The snow shader is the important one: corduroy grooves and
// sparkle are far too fine to put in geometry, so they're injected into a
// Phong material's fragment stage and faded out by derivative width to keep
// them from aliasing into noise at distance.

import * as THREE from 'three';

export function makeSnowMaterial(weather) {
  const mat = new THREE.MeshPhongMaterial({
    vertexColors: true,
    shininess: weather.snowShine ?? 26,
    specular: new THREE.Color(weather.snowSpec ?? 0x2b3648),
    flatShading: false,
  });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSparkle = { value: weather.sparkle ?? 1 };
    shader.uniforms.uTime = { value: 0 };
    mat.userData.shader = shader;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        attribute float aGroom;
        varying float vGroom;
        varying vec3 vWorld;
      `)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        vGroom = aGroom;
        vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `
        #include <common>
        uniform float uSparkle;
        uniform float uTime;
        varying float vGroom;
        varying vec3 vWorld;

        float hash21(vec2 p) {
          p = fract(p * vec2(233.34, 851.73));
          p += dot(p, p + 23.45);
          return fract(p.x * p.y);
        }
      `)
      .replace('#include <color_fragment>', `
        #include <color_fragment>

        // Corduroy: ridges run down the fall line, so they vary across X.
        // fwidth tells us when a pixel spans more than a groove; fade there.
        float cx = vWorld.x * 3.2;
        float gw = fwidth(cx);
        float gFade = 1.0 - smoothstep(0.12, 0.55, gw);
        float groove = sin(cx * 6.2831853);
        diffuseColor.rgb *= 1.0 + groove * 0.045 * gFade * vGroom;

        // Wind texture on ungroomed snow — coarser, and it survives further out.
        float wx = vWorld.x * 0.09 + vWorld.z * 0.03;
        float wz = vWorld.z * 0.11 - vWorld.x * 0.02;
        float wind = sin(wx * 6.2831853) * sin(wz * 6.2831853 * 0.7);
        diffuseColor.rgb *= 1.0 + wind * 0.028 * (1.0 - vGroom);

        // Sparkle. Each cell gets at most one sub-cell *point*, not a filled
        // cell — otherwise at a skier's shallow viewing angle the cells smear
        // into a visible grid of white quads rather than reading as glitter.
        float dist = length(vWorld - cameraPosition);
        float near = 1.0 - smoothstep(4.0, 32.0, dist);
        if (near > 0.002 && uSparkle > 0.002) {
          vec2 uv = vWorld.xz * 20.0;
          vec2 cell = floor(uv);
          float h = hash21(cell);
          if (h > 0.9915) {
            vec2 pt = vec2(hash21(cell + 3.71), hash21(cell + 11.37));
            float d = length(fract(uv) - pt);
            float tw = 0.5 + 0.5 * sin(uTime * 3.6 + h * 180.0);
            // Fade out once a pixel spans more than a cell, same trick as the
            // corduroy, or the glints alias into crawling noise at distance.
            float sFade = 1.0 - smoothstep(0.3, 1.0, fwidth(uv.x));
            float glint = (1.0 - smoothstep(0.0, 0.3, d)) * tw * sFade;
            diffuseColor.rgb += glint * near * uSparkle * 0.5;
          }
        }
      `);
  };

  mat.customProgramCacheKey = () => 'snow';
  return mat;
}

export function updateSnowMaterial(mat, time) {
  const s = mat.userData.shader;
  if (s) s.uniforms.uTime.value = time;
}

/**
 * Foliage material with a cheap wind sway driven in the vertex shader.
 * Instance matrices already place the trees; sway is applied in local space so
 * trunks stay planted and only the upper geometry moves.
 */
export function makeFoliageMaterial(color, windStrength = 1) {
  const mat = new THREE.MeshLambertMaterial({ color, vertexColors: false });

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uWind = { value: windStrength };
    mat.userData.shader = shader;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `
        #include <common>
        uniform float uTime;
        uniform float uWind;
      `)
      .replace('#include <begin_vertex>', `
        #include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 iOrigin = instanceMatrix[3].xyz;
        #else
          vec3 iOrigin = vec3(0.0);
        #endif
        float sway = sin(uTime * 1.35 + iOrigin.x * 0.09 + iOrigin.z * 0.07)
                   + 0.4 * sin(uTime * 2.7 + iOrigin.z * 0.15);
        float hFactor = max(0.0, transformed.y) * 0.055;
        transformed.x += sway * hFactor * uWind;
        transformed.z += sway * 0.6 * hFactor * uWind;
      `);
  };

  mat.customProgramCacheKey = () => 'foliage' + windStrength.toFixed(2);
  return mat;
}

export function updateFoliage(mat, time) {
  const s = mat.userData.shader;
  if (s) s.uniforms.uTime.value = time;
}

export const makeRockMaterial = (color = 0x5c5651) =>
  new THREE.MeshLambertMaterial({ color, flatShading: true });

export const makeIceMaterial = () =>
  new THREE.MeshPhongMaterial({
    color: 0x9fd0e8, shininess: 90, specular: 0x88ccff,
    transparent: true, opacity: 0.82, flatShading: true,
  });

export const makeMetalMaterial = (color = 0x8f97a3) =>
  new THREE.MeshPhongMaterial({ color, shininess: 70, specular: 0x555a63 });

export const makePaintMaterial = (color, flat = true) =>
  new THREE.MeshLambertMaterial({ color, flatShading: flat });
