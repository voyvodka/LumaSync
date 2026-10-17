// Selective bloom: a luminance threshold could not pick the bulbs out — a wall beside a lamp is
// lit brighter than the bulb — so a second pass draws everything else black (still occluding).
import {
  type Camera,
  HalfFloatType,
  type Line,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  type Points,
  type Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type WebGLRenderer,
} from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";

export const BLOOM_LAYER = 1;
/** `userData` flag: hidden from the glow pass, whose black stand-in writes depth over the bulbs. */
export const OVERLAY = "overlay";

/** Left out of the glow pass rather than drawn black: overlays, points and every kind of line, the
 *  plumb's dashed `Line` included, which a check for `LineSegments` alone let glow. */
export function glowPassHides(object: Object3D): boolean {
  return Boolean(object.userData[OVERLAY]) || (object as Points).isPoints === true || (object as Line).isLine === true;
}

const STRENGTH = 1.4;
const RADIUS = 0.35;

export interface Bloom {
  render(scene: Scene, camera: Camera): void;
  setSize(width: number, height: number): void;
  dispose(): void;
}

const MIX = {
  uniforms: { baseTexture: { value: null }, bloomTexture: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D baseTexture;
    uniform sampler2D bloomTexture;
    varying vec2 vUv;
    void main() {
      vec4 base = texture2D(baseTexture, vUv);
      vec3 glow = texture2D(bloomTexture, vUv).rgb;
      gl_FragColor = vec4(base.rgb + glow, max(base.a, max(glow.r, max(glow.g, glow.b))));
    }`,
};

export function createBloom(renderer: WebGLRenderer, multisample: boolean): Bloom {
  const black = new MeshBasicMaterial({ color: 0x000000 });
  const glowPass = new RenderPass(undefined as unknown as Scene, undefined as unknown as Camera);
  const bloomPass = new UnrealBloomPass(new Vector2(1, 1), STRENGTH, RADIUS, 0);
  const glowComposer = new EffectComposer(renderer, new WebGLRenderTarget(1, 1, { type: HalfFloatType }));
  glowComposer.renderToScreen = false;
  glowComposer.addPass(glowPass);
  glowComposer.addPass(bloomPass);

  // The composer's own target has no MSAA unless asked; the renderer's antialias stops at it.
  const roomTarget = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: multisample ? 4 : 0 });
  const composer = new EffectComposer(renderer, roomTarget);
  const roomPass = new RenderPass(undefined as unknown as Scene, undefined as unknown as Camera);
  const mix = new ShaderPass(new ShaderMaterial(MIX), "baseTexture");
  composer.addPass(roomPass);
  composer.addPass(mix);
  composer.addPass(new OutputPass());

  const kept = new Map<Mesh, Material | Material[]>();
  const hidden: Object3D[] = [];
  const darken = (scene: Scene) => {
    scene.traverse((object) => {
      if (object.layers.isEnabled(BLOOM_LAYER) || !object.visible) return;
      if (glowPassHides(object)) {
        hidden.push(object);
        object.visible = false;
      } else if (object instanceof Mesh) {
        kept.set(object, object.material);
        object.material = black;
      }
    });
  };
  const restore = () => {
    for (const [mesh, material] of kept) mesh.material = material;
    for (const object of hidden) object.visible = true;
    kept.clear();
    hidden.length = 0;
  };

  return {
    render(scene, camera) {
      glowPass.scene = scene;
      glowPass.camera = camera;
      roomPass.scene = scene;
      roomPass.camera = camera;
      const shadowsWere = renderer.shadowMap.enabled;
      renderer.shadowMap.enabled = false;
      darken(scene);
      try {
        glowComposer.render();
      } finally {
        restore();
        renderer.shadowMap.enabled = shadowsWere;
      }
      mix.uniforms.bloomTexture!.value = glowComposer.readBuffer.texture;
      composer.render();
    },
    setSize(width, height) {
      const ratio = renderer.getPixelRatio();
      composer.setPixelRatio(ratio);
      composer.setSize(width, height);
      glowComposer.setPixelRatio(ratio / 2);
      glowComposer.setSize(width, height);
    },
    dispose() {
      bloomPass.dispose();
      glowComposer.dispose();
      composer.dispose();
      mix.material.dispose();
      black.dispose();
    },
  };
}
