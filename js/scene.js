// Three.js scene: Earth (real day/night + rotation), the Moon, and every
// asteroid on its computed trajectory. Distances from Earth are compressed
// logarithmically so a 6,000 km flyby and a 70M km one share the screen.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { EARTH_RADIUS_KM, LD_KM, OBLIQUITY, jdFromMs, earthHelio, moonGeoKm, gmst } from './astro.js';
import { hash, mulberry32 } from './neo.js';
import { escapeHtml, ld as fmtLD } from './format.js';

const TEXTURE_BASE = 'https://cdn.jsdelivr.net/npm/three-globe@2.45.2/example/img/';
const LOG_SCALE = 3.2;
const TRAIL_SPAN_MS = 8 * 86400e3;
const TRAIL_SAMPLES = 400;
const RING_LDS = [10, 30, 100];
const HOME_DIR = new THREE.Vector3(0, 0.42, 1).normalize();

const COLORS = {
  safe: new THREE.Color('#4fd8ff'),
  hazard: new THREE.Color('#ff5a5f'),
};

const WARNING_SVG = '<svg class="nl-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.8 19.5h18.4L12 3.5Z"/><path d="M12 10v4.5"/><path d="M12 17.2v.1"/></svg>';

export function sceneRadius(km) {
  return 1 + LOG_SCALE * Math.log10(Math.max(km, EARTH_RADIUS_KM) / EARTH_RADIUS_KM);
}

/** Ecliptic [x, y, z] km → three.js space (y-up = ecliptic north), log-compressed. */
function toScene(v, out) {
  const d = Math.hypot(v[0], v[1], v[2]) || 1;
  const s = sceneRadius(d) / d;
  return out.set(v[0] * s, v[2] * s, -v[1] * s);
}

function eclipticDir(v, out) {
  return out.set(v[0], v[2], -v[1]).normalize();
}

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class SpaceScene {
  constructor(container, handlers = {}) {
    this.container = container;
    this.handlers = handlers;
    this.items = new Map();
    this.time = Date.now();
    this.timeDirty = true;
    this.hovered = null;
    this.selected = null;
    this.follow = null;
    this.fly = null;
    this.showLabels = true;
    this.showTrails = true;
    this.lastTrailTime = -Infinity;
    this.resolution = new THREE.Vector2(1, 1);
    this._v = new THREE.Vector3();
    this._sun = new THREE.Vector3();

    this.initRenderer();
    this.buildStars();
    this.buildSun();
    this.buildEarth();
    this.buildMoon();
    this.buildGuides();
    this.buildSelectionUI();

    this.asteroids = new THREE.Group();
    this.scene.add(this.asteroids);
    this.glowTexture = makeGlowTexture();
    this.rockGeometries = Array.from({ length: 8 }, (_, i) => makeRockGeometry(1000 + i * 7919));

    this.homeDistance = 40;
    this.focusElement = handlers.focusElement ?? null;
    this.bindPointer();
    this.resize();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    if (this.focusElement) ro.observe(this.focusElement);

    // Intro: drift in from deep space.
    this.camera.position.copy(HOME_DIR).multiplyScalar(180);
    this.resetView(2600);

    this.lastFrame = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  initRenderer() {
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x02040a, 1);
    this.container.appendChild(renderer.domElement);
    this.renderer = renderer;

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.domElement.className = 'label-layer';
    this.container.appendChild(this.labelRenderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 4000);

    const controls = new OrbitControls(this.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.minDistance = 2.2;
    controls.maxDistance = 160;
    controls.rotateSpeed = 0.55;
    controls.zoomSpeed = 0.9;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.18;
    controls.addEventListener('start', () => {
      controls.autoRotate = false;
      this.handlers.onAutoRotate?.(false);
      if (this.fly) {
        this.follow = this.fly.item;
        this.fly = null;
      }
    });
    this.controls = controls;

    this.scene.add(new THREE.AmbientLight(0x8fa6d8, 0.35));
  }

  buildStars() {
    const count = 9000;
    const rand = mulberry32(42);
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    const galaxyNormal = new THREE.Vector3(0.35, 0.75, 0.56).normalize();
    const v = new THREE.Vector3();
    const tint = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const z = rand() * 2 - 1;
      const phi = rand() * Math.PI * 2;
      const r = Math.sqrt(1 - z * z);
      v.set(r * Math.cos(phi), z, r * Math.sin(phi));
      // Crowd ~40% of stars toward a band to suggest the Milky Way.
      if (rand() < 0.4) v.addScaledVector(galaxyNormal, -v.dot(galaxyNormal) * (0.82 + rand() * 0.16)).normalize();
      v.multiplyScalar(1400 + rand() * 600);
      positions.set([v.x, v.y, v.z], i * 3);
      const temp = rand();
      tint.setRGB(0.75 + temp * 0.25, 0.8 + temp * 0.15, 1.0 - temp * 0.2);
      const bright = 0.25 + rand() ** 3 * 0.9;
      colors.set([tint.r * bright, tint.g * bright, tint.b * bright], i * 3);
      sizes[i] = 0.8 + rand() ** 10 * 3.6;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { pixelRatio: { value: this.renderer.getPixelRatio() } },
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aSize;
        uniform float pixelRatio; varying vec3 vColor;
        void main() {
          vColor = aColor;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * pixelRatio;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vColor;
        void main() {
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          gl_FragColor = vec4(vColor * a * a, 1.0);
        }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.stars = new THREE.Points(geo, mat);
    this.scene.add(this.stars);
  }

  buildSun() {
    this.sunLight = new THREE.DirectionalLight(0xfff4e6, 2.6);
    this.scene.add(this.sunLight, this.sunLight.target);

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture([[0, 'rgba(255,244,220,0.9)'], [0.08, 'rgba(255,220,160,0.45)'], [0.3, 'rgba(255,170,90,0.08)'], [1, 'rgba(255,150,80,0)']]),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }));
    halo.scale.setScalar(260);
    const core = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture([[0, 'rgba(255,255,255,1)'], [0.25, 'rgba(255,250,235,0.9)'], [0.5, 'rgba(255,230,190,0.15)'], [1, 'rgba(255,220,180,0)']]),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    }));
    core.scale.setScalar(40);
    this.sun = new THREE.Group();
    this.sun.add(halo, core);
    this.sunLabel = makeLabel('scene-label sun-label', '<span>Sun</span>');
    this.sunLabel.center.set(0.5, -1.6);
    this.sun.add(this.sunLabel);
    this.scene.add(this.sun);
  }

  buildEarth() {
    this.earthTilt = new THREE.Group();
    this.earthTilt.rotation.x = -OBLIQUITY;
    this.earthSpin = new THREE.Group();
    this.earthTilt.add(this.earthSpin);
    this.scene.add(this.earthTilt);

    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
    blank.needsUpdate = true;
    this.earthUniforms = {
      dayMap: { value: blank },
      nightMap: { value: blank },
      waterMap: { value: blank },
      sunDir: { value: new THREE.Vector3(1, 0, 0) },
      ready: { value: 0 },
    };
    const earth = new THREE.Mesh(
      new THREE.SphereGeometry(1, 128, 96),
      new THREE.ShaderMaterial({
        uniforms: this.earthUniforms,
        vertexShader: /* glsl */ `
          varying vec2 vUv; varying vec3 vNormal; varying vec3 vPos;
          void main() {
            vUv = uv;
            vNormal = normalize(mat3(modelMatrix) * normal);
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          uniform sampler2D dayMap; uniform sampler2D nightMap; uniform sampler2D waterMap;
          uniform vec3 sunDir; uniform float ready;
          varying vec2 vUv; varying vec3 vNormal; varying vec3 vPos;
          void main() {
            vec3 n = normalize(vNormal);
            vec3 viewDir = normalize(cameraPosition - vPos);
            float ndl = dot(n, sunDir);
            float dayMix = smoothstep(-0.12, 0.22, ndl);

            vec3 day = mix(vec3(0.04, 0.12, 0.28), texture2D(dayMap, vUv).rgb, ready);
            vec3 night = texture2D(nightMap, vUv).rgb * ready;
            float water = texture2D(waterMap, vUv).r * ready;

            vec3 lit = day * (0.06 + 1.15 * max(ndl, 0.0));
            vec3 dark = night * vec3(1.0, 0.78, 0.5) * 1.6 + day * 0.015;
            vec3 col = mix(dark, lit, dayMix);

            vec3 h = normalize(sunDir + viewDir);
            col += vec3(1.0, 0.93, 0.8) * pow(max(dot(n, h), 0.0), 60.0) * water * 0.55 * dayMix;

            float fres = pow(1.0 - max(dot(n, viewDir), 0.0), 2.6);
            col += vec3(0.32, 0.58, 1.0) * fres * (0.12 + 0.95 * smoothstep(-0.35, 0.55, ndl));

            gl_FragColor = vec4(col, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    );
    this.earthSpin.add(earth);
    this.earth = earth;

    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(1.16, 96, 64),
      new THREE.ShaderMaterial({
        uniforms: { sunDir: this.earthUniforms.sunDir },
        vertexShader: /* glsl */ `
          varying vec3 vNormal; varying vec3 vPos;
          void main() {
            vNormal = normalize(mat3(modelMatrix) * normal);
            vec4 wp = modelMatrix * vec4(position, 1.0);
            vPos = wp.xyz;
            gl_Position = projectionMatrix * viewMatrix * wp;
          }`,
        fragmentShader: /* glsl */ `
          uniform vec3 sunDir; varying vec3 vNormal; varying vec3 vPos;
          void main() {
            vec3 viewDir = normalize(cameraPosition - vPos);
            float rim = clamp(-dot(normalize(vNormal), viewDir), 0.0, 1.0);
            float glow = pow(smoothstep(0.0, 0.5, rim), 2.4);
            float sunF = 0.12 + 0.88 * smoothstep(-0.45, 0.5, dot(normalize(vNormal), sunDir));
            vec3 col = mix(vec3(0.2, 0.45, 1.0), vec3(0.55, 0.8, 1.0), glow);
            gl_FragColor = vec4(col * glow * sunF * 1.25, 1.0);
          }`,
        side: THREE.BackSide,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.scene.add(atmosphere);

    const loader = new THREE.TextureLoader();
    const load = (file, srgb = true) => new Promise((resolve, reject) => {
      loader.load(TEXTURE_BASE + file, (tex) => {
        if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        resolve(tex);
      }, undefined, reject);
    });
    Promise.all([load('earth-blue-marble.jpg'), load('earth-night.jpg'), load('earth-water.png', false)])
      .then(([day, night, water]) => {
        this.earthUniforms.dayMap.value = day;
        this.earthUniforms.nightMap.value = night;
        this.earthUniforms.waterMap.value = water;
        this.earthUniforms.ready.value = 1;
      })
      .catch(() => { /* keep the stylised fallback globe */ });
  }

  buildMoon() {
    this.moon = new THREE.Mesh(
      new THREE.SphereGeometry(0.27, 64, 48),
      new THREE.MeshStandardMaterial({ map: makeMoonTexture(), roughness: 1, metalness: 0 }),
    );
    const label = makeLabel('scene-label moon-label', '<span>Moon</span>');
    label.center.set(0.5, -1.4);
    this.moon.add(label);
    this.scene.add(this.moon);

    this.moonOrbit = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xa9b8dc, transparent: true, opacity: 0.28, depthWrite: false }),
    );
    this.scene.add(this.moonOrbit);
  }

  buildGuides() {
    const guides = new THREE.Group();
    const ringMat = new THREE.LineDashedMaterial({
      color: 0x7f9bd6, transparent: true, opacity: 0.22, dashSize: 0.35, gapSize: 0.3, depthWrite: false,
    });
    let outer = 0;
    for (const [index, ldValue] of RING_LDS.entries()) {
      const r = sceneRadius(ldValue * LD_KM);
      outer = Math.max(outer, r);
      const pts = [];
      for (let i = 0; i <= 256; i++) {
        const a = (i / 256) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
      const ring = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), ringMat);
      ring.computeLineDistances();
      guides.add(ring);
      const label = makeLabel('scene-label ring-label', `<span>${ldValue} LD</span>`);
      const a = Math.PI * 0.5 - 0.5 - index * 0.09; // near side, staggered so labels don't stack
      label.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
      guides.add(label);
    }
    const spokeMat = new THREE.LineBasicMaterial({ color: 0x7f9bd6, transparent: true, opacity: 0.07, depthWrite: false });
    const spokes = [];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      spokes.push(new THREE.Vector3(Math.cos(a) * 1.6, 0, Math.sin(a) * 1.6), new THREE.Vector3(Math.cos(a) * outer, 0, Math.sin(a) * outer));
    }
    guides.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(spokes), spokeMat));
    this.guides = guides;
    this.scene.add(guides);
  }

  buildSelectionUI() {
    const reticleEl = document.createElement('div');
    reticleEl.className = 'reticle';
    reticleEl.innerHTML = '<span class="reticle-ring"></span><span class="reticle-core"></span>';
    this.reticle = new CSS2DObject(reticleEl);
    this.reticle.visible = false;
    this.scene.add(this.reticle);

    this.rangeLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(1, 0, 0)]),
      new THREE.LineDashedMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, dashSize: 0.18, gapSize: 0.14, depthWrite: false }),
    );
    this.rangeLine.visible = false;
    this.rangeLine.frustumCulled = false;
    this.scene.add(this.rangeLine);

    const rangeEl = document.createElement('div');
    rangeEl.className = 'range-label';
    this.rangeLabel = new CSS2DObject(rangeEl);
    this.rangeLabel.visible = false;
    this.scene.add(this.rangeLabel);
  }

  /* ---------------------------------------------------------------- data */

  setAsteroids(neos) {
    for (const item of this.items.values()) {
      this.asteroids.remove(item.group, item.trail.line, item.caMarker);
      item.labelEl.remove(); // CSS2DRenderer only cleans up directly-removed labels
      item.trail.line.geometry.dispose();
      item.trail.line.material.dispose();
      item.rock.material.dispose();
      item.glow.material.dispose();
      item.caMarker.material.dispose();
    }
    this.items.clear();
    this.hovered = null;
    this.selected = null;
    this.follow = null;
    this.reticle.visible = false;

    for (const neo of neos) {
      const item = this.createItem(neo);
      this.items.set(neo.id, item);
    }
    this.updateBodies(); // positions must be valid before anything flies to them
    this.timeDirty = false;
    this.lastTrailTime = -Infinity;
    this.refreshEmphasis();
  }

  createItem(neo) {
    const color = neo.hazardous ? COLORS.hazard : COLORS.safe;
    const seed = hash(neo.id);
    const rand = mulberry32(seed);
    const size = THREE.MathUtils.clamp(0.07 + 0.075 * Math.log10(Math.max(neo.dMean, 1)), 0.08, 0.32);

    const group = new THREE.Group();
    const rock = new THREE.Mesh(
      this.rockGeometries[seed % this.rockGeometries.length],
      new THREE.MeshStandardMaterial({
        color: 0x8f877f, roughness: 0.95, metalness: 0, flatShading: true,
        emissive: color, emissiveIntensity: 0.06,
      }),
    );
    rock.scale.setScalar(size);
    rock.rotation.set(rand() * 6, rand() * 6, rand() * 6);

    // Constant on-screen size: a beacon from afar, unobtrusive up close.
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.glowTexture, color, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
      sizeAttenuation: false,
    }));
    glow.scale.setScalar(0.024 + size * 0.07);

    const labelEl = document.createElement('div');
    labelEl.className = `neo-label${neo.hazardous ? ' is-hazard' : ''}`;
    labelEl.innerHTML = `<span class="nl-inner">${neo.hazardous ? WARNING_SVG : ''}<span>${escapeHtml(neo.label)}</span></span>`;
    const label = new CSS2DObject(labelEl);
    group.add(rock, glow, label);

    const trail = this.buildTrail(neo);
    const caMarker = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeRingTexture(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      sizeAttenuation: false, opacity: 0.55,
    }));
    caMarker.scale.setScalar(0.016);
    toScene(neo.posAt(neo.tca), caMarker.position);

    this.asteroids.add(group, trail.line, caMarker);
    return {
      neo, group, rock, glow, label, labelEl, trail, caMarker, color, size,
      spin: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).multiplyScalar(0.8),
      pulse: rand() * Math.PI * 2,
      emphasis: 1,
      filtered: false,
    };
  }

  buildTrail(neo) {
    const times = new Float64Array(TRAIL_SAMPLES);
    const positions = new Float32Array(TRAIL_SAMPLES * 3);
    const v = new THREE.Vector3();
    const k = 3.2;
    const sk = Math.sinh(k);
    for (let i = 0; i < TRAIL_SAMPLES; i++) {
      const u = (i / (TRAIL_SAMPLES - 1)) * 2 - 1;
      const t = neo.tca + (TRAIL_SPAN_MS * Math.sinh(k * u)) / sk; // denser near closest approach
      times[i] = t;
      toScene(neo.posAt(t), v);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
    }
    const geo = new LineGeometry();
    geo.setPositions(positions);
    geo.setColors(new Float32Array(TRAIL_SAMPLES * 3));
    const mat = new LineMaterial({
      linewidth: 1.7, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    mat.resolution.copy(this.resolution);
    const line = new Line2(geo, mat);
    return { line, times, colors: geo.attributes.instanceColorStart.data, brightness: new Float32Array(TRAIL_SAMPLES) };
  }

  paintTrail(item) {
    const { times, colors, brightness } = item.trail;
    const arr = colors.array;
    const c = item.color;
    const e = item.emphasis;
    for (let i = 0; i < TRAIL_SAMPLES; i++) {
      const dtH = (times[i] - this.time) / 3600e3;
      const b = dtH < 0 ? 0.04 + 0.62 * Math.exp(dtH / 48) : 0.04 + 0.24 * Math.exp(-dtH / 30);
      brightness[i] = b * e;
    }
    for (let s = 0; s < TRAIL_SAMPLES - 1; s++) {
      const o = s * 6;
      const b0 = brightness[s];
      const b1 = brightness[s + 1];
      arr[o] = c.r * b0; arr[o + 1] = c.g * b0; arr[o + 2] = c.b * b0;
      arr[o + 3] = c.r * b1; arr[o + 4] = c.g * b1; arr[o + 5] = c.b * b1;
    }
    colors.needsUpdate = true;
  }

  /* ---------------------------------------------------------------- state */

  setTime(ms) {
    if (ms !== this.time) {
      this.time = ms;
      this.timeDirty = true;
    }
  }

  /** Moon orbit is re-sampled when the viewed day changes. */
  setDay(dayStartMs) {
    const pts = [];
    const v = new THREE.Vector3();
    const start = dayStartMs - 14 * 86400e3;
    for (let i = 0; i <= 400; i++) {
      toScene(moonGeoKm(jdFromMs(start + (i / 400) * 28 * 86400e3)), v);
      pts.push(v.clone());
    }
    this.moonOrbit.geometry.dispose();
    this.moonOrbit.geometry = new THREE.BufferGeometry().setFromPoints(pts);
  }

  setFilter(predicate) {
    for (const item of this.items.values()) {
      item.filtered = !predicate(item.neo);
      this.applyVisibility(item);
    }
  }

  setLabelsVisible(on) {
    this.showLabels = on;
    for (const item of this.items.values()) this.applyVisibility(item);
  }

  setTrailsVisible(on) {
    this.showTrails = on;
    for (const item of this.items.values()) this.applyVisibility(item);
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
  }

  applyVisibility(item) {
    const focus = item === this.selected || item === this.hovered;
    item.group.visible = !item.filtered;
    item.label.visible = !item.filtered && (this.showLabels || focus);
    item.trail.line.visible = !item.filtered && (this.showTrails || focus);
    item.caMarker.visible = item.trail.line.visible;
  }

  setHovered(id) {
    const item = id ? this.items.get(id) ?? null : null;
    if (item === this.hovered) return;
    this.hovered = item;
    this.renderer.domElement.style.cursor = item ? 'pointer' : '';
    this.refreshEmphasis();
  }

  setSelected(id, { fly = true } = {}) {
    const item = id ? this.items.get(id) ?? null : null;
    this.selected = item;
    this.follow = null;
    if (item) {
      if (fly) this.flyToItem(item);
      else this.follow = item;
    }
    this.refreshEmphasis();
  }

  refreshEmphasis() {
    for (const item of this.items.values()) {
      let e = 1;
      if (item === this.selected) e = 2.1;
      else if (item === this.hovered) e = 1.7;
      else if (this.selected) e = 0.32;
      item.emphasis = e;
      item.labelEl.classList.toggle('is-selected', item === this.selected);
      item.labelEl.classList.toggle('is-hovered', item === this.hovered);
      item.labelEl.classList.toggle('is-dim', e < 1);
      item.rock.material.emissiveIntensity = e > 1 ? 0.12 : 0.06;
      this.applyVisibility(item);
    }
    this.lastTrailTime = -Infinity;
  }

  /* --------------------------------------------------------------- camera */

  flyTo(position, target, item = null, duration = 1400) {
    this.follow = null;
    this.followLast = null;
    this.fly = {
      start: performance.now(),
      duration,
      p0: this.camera.position.clone(),
      t0: this.controls.target.clone(),
      p1: position,
      t1: target,
      offset: position.clone().sub(target),
      item,
    };
  }

  flyToItem(item) {
    const p = toScene(item.neo.posAt(this.time), new THREE.Vector3());
    const out = p.lengthSq() > 0 ? p.clone().normalize() : HOME_DIR.clone();
    const up = new THREE.Vector3(0, 1, 0);
    const side = new THREE.Vector3().crossVectors(out, up);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0);
    side.normalize();
    // Behind the asteroid (seen from Earth) and slightly off-axis, so Earth sits beside it in frame.
    const cam = p.clone().addScaledVector(out, 7).addScaledVector(up, 1.1).addScaledVector(side, 2.2);
    this.flyTo(cam, p, item);
  }

  focusSelected() {
    if (this.selected) this.flyToItem(this.selected);
  }

  resetView(duration = 1400) {
    this.flyTo(HOME_DIR.clone().multiplyScalar(this.homeDistance), new THREE.Vector3(), null, duration);
  }

  /** Pick a home distance that fits every visible asteroid inside the focus area. */
  frameAll() {
    let radius = sceneRadius(LD_KM * 1.2); // always keep the Moon's orbit in view
    for (const item of this.items.values()) {
      if (!item.filtered) radius = Math.max(radius, toScene(item.neo.posAt(this.time), this._v).length());
    }
    this.homeDistance = THREE.MathUtils.clamp(this.fitDistance(radius * 1.08 + 0.4), 18, 110);
    if (!this.selected) this.resetView(this.fly ? Math.max(900, this.fly.duration - (performance.now() - this.fly.start)) : 1400);
  }

  fitDistance(radius) {
    const rect = this.focusRect();
    const h = this.container.clientHeight || window.innerHeight;
    const t = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const half = Math.atan((t * Math.min(rect.width, rect.height)) / h);
    return radius / Math.sin(half);
  }

  focusRect() {
    const box = this.container.getBoundingClientRect();
    const r = this.focusElement?.getBoundingClientRect();
    if (!r || r.width < 50 || r.height < 50) return { x: 0, y: 0, width: box.width, height: box.height };
    return { x: r.left - box.left, y: r.top - box.top, width: r.width, height: r.height };
  }

  /* -------------------------------------------------------------- picking */

  bindPointer() {
    const el = this.renderer.domElement;
    let down = null;
    el.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    el.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const item = this.pick(e.clientX, e.clientY);
      if (item) this.handlers.onSelect?.(item.neo.id);
    });
    el.addEventListener('pointermove', (e) => {
      if (e.buttons) return;
      const item = this.pick(e.clientX, e.clientY);
      this.handlers.onHover?.(item ? item.neo.id : null, e.clientX, e.clientY);
    });
    el.addEventListener('pointerleave', () => this.handlers.onHover?.(null));
  }

  pick(cx, cy) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    let best = null;
    let bestD = 22;
    for (const item of this.items.values()) {
      if (!item.group.visible) continue;
      this._v.copy(item.group.position).project(this.camera);
      if (this._v.z > 1) continue;
      const sx = rect.left + ((this._v.x + 1) / 2) * rect.width;
      const sy = rect.top + ((1 - this._v.y) / 2) * rect.height;
      const d = Math.hypot(sx - cx, sy - cy);
      if (d < bestD) { bestD = d; best = item; }
    }
    if (best) return best;
    for (const item of this.items.values()) {
      if (!item.label.visible || !item.group.visible) continue;
      const r = item.labelEl.firstElementChild.getBoundingClientRect();
      if (r.width && cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return item;
    }
    return null;
  }

  /** Screen position of an asteroid (for anchoring tooltips), or null. */
  screenPosition(id) {
    const item = this.items.get(id);
    if (!item) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this._v.copy(item.group.position).project(this.camera);
    return { x: rect.left + ((this._v.x + 1) / 2) * rect.width, y: rect.top + ((1 - this._v.y) / 2) * rect.height };
  }

  /* ---------------------------------------------------------------- frame */

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    // Centre the projection on the open area between the HUD panels.
    const f = this.focusRect();
    this.camera.setViewOffset(w, h, w / 2 - (f.x + f.width / 2), h / 2 - (f.y + f.height / 2), w, h);
    this.camera.updateProjectionMatrix();
    this.resolution.set(w, h);
    for (const item of this.items.values()) item.trail.line.material.resolution.set(w, h);
  }

  updateBodies() {
    const jd = jdFromMs(this.time);
    const e = earthHelio(jd);
    eclipticDir([-e[0], -e[1], -e[2]], this._sun);
    this.earthUniforms.sunDir.value.copy(this._sun);
    this.sunLight.position.copy(this._sun).multiplyScalar(50);
    this.sun.position.copy(this._sun).multiplyScalar(1500);
    this.earthSpin.rotation.y = gmst(jd);
    toScene(moonGeoKm(jd), this.moon.position);

    for (const item of this.items.values()) toScene(item.neo.posAt(this.time), item.group.position);
  }

  updateSelectionUI() {
    const item = this.selected;
    const show = !!item && item.group.visible;
    this.reticle.visible = show;
    this.rangeLine.visible = show;
    this.rangeLabel.visible = show;
    if (!show) return;
    const p = item.group.position;
    this.reticle.position.copy(p);
    const start = this._v.copy(p).normalize().multiplyScalar(1.05);
    const pos = this.rangeLine.geometry.attributes.position;
    pos.setXYZ(0, start.x, start.y, start.z);
    pos.setXYZ(1, p.x, p.y, p.z);
    pos.needsUpdate = true;
    this.rangeLine.computeLineDistances();
    this.rangeLabel.position.copy(start).lerp(p, 0.5);
    const d = Math.hypot(...item.neo.posAt(this.time)) / LD_KM;
    const text = `${fmtLD(d)} LD`;
    if (this.rangeLabel.element.textContent !== text) this.rangeLabel.element.textContent = text;
  }

  frame() {
    const now = performance.now();
    const dt = Math.min((now - this.lastFrame) / 1000, 0.1);
    this.lastFrame = now;

    this.handlers.onTick?.(dt);

    if (this.timeDirty) {
      this.updateBodies();
      this.timeDirty = false;
    }
    if (Math.abs(this.time - this.lastTrailTime) > 15e3) {
      for (const item of this.items.values()) this.paintTrail(item);
      this.lastTrailTime = this.time;
    }

    const t = now / 1000;
    for (const item of this.items.values()) {
      item.rock.rotation.x += item.spin.x * dt;
      item.rock.rotation.y += item.spin.y * dt;
      const base = item.emphasis < 1 ? 0.3 : item.emphasis > 1 ? 1 : 0.8;
      const pulse = item.neo.hazardous ? 0.78 + 0.22 * Math.sin(t * 2.6 + item.pulse) : 1;
      item.glow.material.opacity = base * pulse;
    }

    this.updateCamera(now);
    this.updateSelectionUI();
    this.controls.update(dt);
    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);
    if (now - (this.lastDeclutter ?? 0) > 120) {
      this.lastDeclutter = now;
      this.declutterLabels();
    }
  }

  /** Hide labels that collide with a higher-priority one (hover reveals them). */
  declutterLabels() {
    const priority = (item) => (item === this.selected ? 1e6 : 0) + (item === this.hovered ? 1e5 : 0)
      + (item.neo.hazardous ? 1e4 : 0) - item.neo.missLD;
    const items = [...this.items.values()]
      .filter((item) => item.label.visible && item.group.visible)
      .sort((a, b) => priority(b) - priority(a));
    const placed = [];
    for (const item of items) {
      const r = item.labelEl.firstElementChild.getBoundingClientRect();
      const hit = r.width > 0 && placed.some((b) => r.left < b.right + 4 && r.right + 4 > b.left && r.top < b.bottom + 2 && r.bottom + 2 > b.top);
      item.labelEl.classList.toggle('is-culled', hit);
      if (!hit) placed.push(r);
    }
  }

  updateCamera(now) {
    const fly = this.fly;
    if (fly) {
      const k = easeInOut(Math.min(1, (now - fly.start) / fly.duration));
      const t1 = fly.item ? fly.item.group.position : fly.t1;
      const p1 = fly.item ? this._v.copy(t1).add(fly.offset) : fly.p1;
      this.camera.position.lerpVectors(fly.p0, p1, k);
      this.controls.target.lerpVectors(fly.t0, t1, k);
      if (k >= 1) {
        this.fly = null;
        this.follow = fly.item;
        if (fly.item) this.followLast = fly.item.group.position.clone();
      }
      return;
    }
    if (this.follow) {
      const p = this.follow.group.position;
      if (!this.followLast) this.followLast = p.clone();
      const delta = this._v.copy(p).sub(this.followLast);
      this.camera.position.add(delta);
      this.controls.target.add(delta);
      this.followLast.copy(p);
    } else {
      this.followLast = null;
    }
  }
}

/* ------------------------------------------------------------ helpers */

function makeLabel(className, html) {
  const el = document.createElement('div');
  el.className = className;
  el.innerHTML = html;
  return new CSS2DObject(el);
}

function makeGlowTexture(stops = [[0, 'rgba(255,255,255,1)'], [0.12, 'rgba(255,255,255,0.7)'], [0.35, 'rgba(255,255,255,0.16)'], [1, 'rgba(255,255,255,0)']]) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, c] of stops) g.addColorStop(o, c);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

let ringTexture = null;
function makeRingTexture() {
  if (ringTexture) return ringTexture;
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
  ctx.stroke();
  ringTexture = new THREE.CanvasTexture(canvas);
  return ringTexture;
}

function makeRockGeometry(seed) {
  const rand = mulberry32(seed);
  const geo = new THREE.IcosahedronGeometry(1, 2);
  const waves = Array.from({ length: 6 }, () => ({
    k: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize().multiplyScalar(1.5 + rand() * 3.5),
    phase: rand() * Math.PI * 2,
    amp: 0.04 + rand() * 0.08,
  }));
  const stretch = new THREE.Vector3(0.85 + rand() * 0.45, 0.7 + rand() * 0.35, 0.8 + rand() * 0.35);
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    let d = 1;
    for (const w of waves) d += w.amp * Math.sin(v.dot(w.k) + w.phase);
    v.multiplyScalar(d).multiply(stretch);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function makeMoonTexture() {
  const w = 1024;
  const h = 512;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const rand = mulberry32(7);
  ctx.fillStyle = '#a4a29e';
  ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 18; i++) {
    ctx.fillStyle = `rgba(55,55,60,${0.18 + rand() * 0.2})`;
    ctx.beginPath();
    ctx.ellipse(rand() * w, h * 0.25 + rand() * h * 0.5, 30 + rand() * 90, 20 + rand() * 60, rand() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let i = 0; i < 6000; i++) {
    ctx.fillStyle = rand() < 0.5 ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.07)';
    ctx.fillRect(rand() * w, rand() * h, 2, 2);
  }
  for (let i = 0; i < 260; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const r = 1.5 + rand() ** 3 * 18;
    ctx.fillStyle = 'rgba(40,40,40,0.28)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(1, r * 0.18);
    ctx.beginPath();
    ctx.arc(x + r * 0.12, y + r * 0.12, r, Math.PI * 0.1, Math.PI * 0.9);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
