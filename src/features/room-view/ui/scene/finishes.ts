// What a surface is made of, as a material: fabric, wood, metal, a satin lacquer, or plain matte.
// Each kind is one shared material per scene, so a room stays a handful of draws. The fine detail —
// a weave, a grain, a brushed sheen — is computed from the world position in the shader, so it
// needs no UVs or texture files and keeps its scale on a piece of any size.
import { type Material, MeshLambertMaterial, MeshStandardMaterial } from "three";

export type FinishKind = "fabric" | "wood" | "metal" | "satin" | "matte" | "leaf";

/** Roughness and metalness per kind, and how strong the shader's detail is. */
const FINISH: Record<FinishKind, { roughness: number; metalness: number; detail: number }> = {
  fabric: { roughness: 0.94, metalness: 0, detail: 1 },
  wood: { roughness: 0.58, metalness: 0, detail: 1 },
  metal: { roughness: 0.34, metalness: 0.7, detail: 1 },
  satin: { roughness: 0.38, metalness: 0.25, detail: 0 },
  matte: { roughness: 0.82, metalness: 0, detail: 0 },
  leaf: { roughness: 0.55, metalness: 0, detail: 1 },
};

const KIND_INDEX: Record<FinishKind, number> = { fabric: 1, wood: 2, metal: 3, leaf: 4, satin: 0, matte: 0 };

// Value noise from a cheap hash. The frequencies stay at centimetres and up: a millimetre weave
// aliases into moiré at the view's distance and reads as noise, not cloth.
const NOISE = /* glsl */ `
float lmHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float lmNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(lmHash(i), lmHash(i + vec2(1.0, 0.0)), u.x), mix(lmHash(i + vec2(0.0, 1.0)), lmHash(i + vec2(1.0, 1.0)), u.x), u.y);
}
`;

const DETAIL = /* glsl */ `
{
  vec3 p = lmWorldPos;
  vec3 n = normalize(lmWorldNormal);
  // On a level face the grain runs across the room; on an upright one, up the face.
  vec2 face = abs(n.y) > 0.5 ? p.xz : vec2(p.x + p.z, p.y);
  float tone = 1.0;
  float rough = 0.0;
  #if LM_FINISH == 1
    float weave = lmNoise(face * 55.0) * 0.6 + lmNoise(face * 140.0) * 0.4;
    float slub = lmNoise(face * 9.0);
    tone = 0.95 + 0.07 * weave + 0.04 * (slub - 0.5);
    rough = 0.04 * (weave - 0.5);
  #elif LM_FINISH == 2
    vec2 g = abs(n.y) > 0.5 ? vec2(p.x * 2.2, p.z * 38.0) : vec2(face.x * 2.2, face.y * 38.0);
    float grain = lmNoise(g + lmNoise(g * 0.35) * 2.5);
    float figure = lmNoise(face * 3.0);
    tone = 0.9 + 0.16 * grain + 0.06 * (figure - 0.5);
    rough = 0.12 * (0.5 - grain);
  #elif LM_FINISH == 4
    // Leaves vary leaf to leaf, not across a leaf: a coarse patch noise, lighter towards the top.
    // Not "patch": a reserved word in GLSL ES 3.0, and the program failed to compile without a word.
    float spot = lmNoise(p.xz * 22.0 + p.y * 9.0);
    tone = 0.82 + 0.3 * spot + 0.12 * clamp(n.y, 0.0, 1.0);
    rough = 0.15 * (0.5 - spot);
  #elif LM_FINISH == 3
    float brush = lmNoise(vec2((p.x + p.z) * 180.0, p.y * 4.0));
    tone = 0.97 + 0.06 * brush;
    rough = 0.1 * (brush - 0.5);
  #endif
  diffuseColor.rgb *= mix(1.0, tone, LM_DETAIL);
  lmRoughnessShift = rough * LM_DETAIL;
}
`;

/** The scene's material for `kind`. Lambert, the spike's cheaper shader, keeps only the colour. */
export function finishMaterial(kind: FinishKind, options: { lambert: boolean; defines?: Record<string, unknown> }): Material {
  if (options.lambert) {
    const material = new MeshLambertMaterial({ vertexColors: true });
    if (options.defines) material.defines = { ...options.defines };
    return material;
  }
  const spec = FINISH[kind];
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: spec.roughness, metalness: spec.metalness });
  material.defines = { ...(options.defines ?? {}), LM_FINISH: KIND_INDEX[kind], LM_DETAIL: spec.detail.toFixed(1) };
  if (spec.detail > 0) {
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 lmWorldPos;\nvarying vec3 lmWorldNormal;")
        .replace(
          "#include <worldpos_vertex>",
          "#include <worldpos_vertex>\nlmWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;\nlmWorldNormal = mat3(modelMatrix) * objectNormal;",
        );
      shader.fragmentShader = shader.fragmentShader
        .replace("#include <common>", `#include <common>\nvarying vec3 lmWorldPos;\nvarying vec3 lmWorldNormal;\n${NOISE}`)
        .replace("#include <color_fragment>", `#include <color_fragment>\nfloat lmRoughnessShift = 0.0;\n${DETAIL}`)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = clamp(roughnessFactor + lmRoughnessShift, 0.04, 1.0);");
    };
    // One compiled program per kind, not one per material instance.
    material.customProgramCacheKey = () => `lm-finish-${kind}`;
  }
  return material;
}
