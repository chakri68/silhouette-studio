export type Tool = "add" | "erase";

/**
 * The single central state object. Mutated in place; changes are pushed to the
 * screen by marking the render loop dirty (see engine/canvas.ts), not by any
 * reactive machinery.
 *
 * Coordinate convention: `scale`/`offset` live in CSS-pixel space. The render
 * loop folds devicePixelRatio in at draw time, so all pointer math stays in CSS
 * pixels and the spec's `screen = image * scale + offset` transform holds as-is.
 */
export interface AppState {
  image: ImageBitmap | null;
  W: number; // native (working) image width
  H: number; // native (working) image height

  tool: Tool; // wired up in phase 2
  brushSize: number; // radius in IMAGE pixels; phase 2

  scale: number; // view zoom
  offset: { x: number; y: number }; // view pan, CSS pixels
  isPainting: boolean; // phase 2
}

export const state: AppState = {
  image: null,
  W: 0,
  H: 0,
  tool: "add",
  brushSize: 40,
  scale: 1,
  offset: { x: 0, y: 0 },
  isPainting: false,
};

export function hasImage(): boolean {
  return state.image !== null;
}
