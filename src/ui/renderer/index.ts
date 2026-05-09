/**
 * Barrel for the renderer layer. External modules import from here
 * rather than reaching into the individual files, so the file layout
 * can change without rippling through the rest of the codebase.
 */

export { CanvasRenderer } from "./canvas.js";
export { WebGLRenderer } from "./webgl.js";
export { TemporalBlender } from "./temporal.js";
export { type ShaderName, type ColorGrade, DEFAULT_COLOR_GRADE } from "./shaders.js";
