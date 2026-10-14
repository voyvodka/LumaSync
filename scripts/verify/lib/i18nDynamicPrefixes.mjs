/** Static heads of live `` t(`prefix.${x}`) `` sites. An unlisted head is only a note() in the i18n
 *  verifier, but orphan accounting under it is unreliable until the list catches up. The contracts
 *  verifier reads it too: `hue:runtime.codes.${code}` means those codes ARE consumed. */
export const KNOWN_DYNAMIC_PREFIXES = [
  "hue:runtime.codes",
  "hue:runtime.states",
  "hue:runtime.writeback.codes",
  "common:hotplug.targetLabel",
  "lights:effect.directions",
  "lights:effect.names",
  "lights:effect.palettes",
  "lights:scenes.suggested",
  "roomMap:furniture.tone",
  "roomMap:furniture.type",
  "roomMap:furniture.variant",
  "settings:nav.sections",
  "telemetry:queueHealth",
];
