import { state } from "../state";
import { getMaskContext, markMaskDirty } from "./canvas";

/**
 * Undo/redo for the selection mask (§7).
 *
 * A snapshot is taken at the START of each stroke — it captures the mask as it
 * was *before* the stroke. Undo/redo then swap the live mask with a stored
 * snapshot. The seed (initial mask at load) is the floor: it becomes the first
 * undo entry the moment the first stroke begins, so you can't undo past it.
 *
 * Snapshots store the alpha channel only. The mask is white-or-transparent, so
 * alpha is the sole information-bearing channel — 1 byte/px instead of 4, while
 * keeping anti-aliased brush edges intact.
 */

const CAP = 20;

interface Snapshot {
  w: number;
  h: number;
  alpha: Uint8ClampedArray;
}

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];
let onChange: (() => void) | null = null;

export function initHistory(): void {
  window.addEventListener("keydown", (e) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const k = e.key.toLowerCase();
    if (k === "z" && !e.shiftKey) {
      e.preventDefault();
      undo();
    } else if ((k === "z" && e.shiftKey) || k === "y") {
      e.preventDefault();
      redo();
    }
  });
}

/** Register a callback fired whenever the stacks change (for button state). */
export function setHistoryListener(cb: () => void): void {
  onChange = cb;
}

export function canUndo(): boolean {
  return undoStack.length > 0;
}

export function canRedo(): boolean {
  return redoStack.length > 0;
}

/** Called on pointer-down, before the first paint of a stroke. */
export function beginStroke(): void {
  undoStack.push(capture());
  if (undoStack.length > CAP) undoStack.shift();
  redoStack = [];
  onChange?.();
}

/**
 * Discard the stroke currently in progress: revert the mask to the snapshot
 * `beginStroke` pushed and drop that entry. Used when a two-finger gesture
 * interrupts a touch stroke — the stray dot the first finger left shouldn't
 * survive as an edit or a history step.
 */
export function abortStroke(): void {
  const snap = undoStack.pop();
  if (!snap) return;
  restore(snap);
  onChange?.();
}

export function undo(): void {
  if (undoStack.length === 0) return;
  redoStack.push(capture());
  restore(undoStack.pop()!);
  onChange?.();
}

export function redo(): void {
  if (redoStack.length === 0) return;
  undoStack.push(capture());
  restore(redoStack.pop()!);
  onChange?.();
}

/**
 * Remap every stored snapshot through the same geometric op just applied to the
 * image (flip/rotate/crop). Keeps undo/redo aligned with the transformed canvas
 * — a snapshot captured before the transform must come back in the *new*
 * geometry or it won't line up with the image. The remap may change dimensions
 * (rotate swaps W/H, crop shrinks), so it returns the new size per snapshot.
 */
export function transformHistory(
  remap: (
    alpha: Uint8ClampedArray,
    w: number,
    h: number,
  ) => { alpha: Uint8ClampedArray; w: number; h: number },
): void {
  const apply = (s: Snapshot): Snapshot => {
    const r = remap(s.alpha, s.w, s.h);
    return { w: r.w, h: r.h, alpha: r.alpha };
  };
  undoStack = undoStack.map(apply);
  redoStack = redoStack.map(apply);
}

/** Drop all history — call when a new image is loaded (or re-seeded). */
export function resetHistory(): void {
  undoStack = [];
  redoStack = [];
  onChange?.();
}

function capture(): Snapshot {
  const { W, H } = state;
  const img = getMaskContext().getImageData(0, 0, W, H);
  const alpha = new Uint8ClampedArray(W * H);
  for (let i = 0, j = 3; i < alpha.length; i++, j += 4) alpha[i] = img.data[j];
  return { w: W, h: H, alpha };
}

function restore(s: Snapshot): void {
  const ctx = getMaskContext();
  const img = ctx.createImageData(s.w, s.h);
  const d = img.data;
  for (let i = 0, j = 0; i < s.alpha.length; i++, j += 4) {
    d[j] = 255;
    d[j + 1] = 255;
    d[j + 2] = 255;
    d[j + 3] = s.alpha[i];
  }
  ctx.putImageData(img, 0, 0);
  markMaskDirty();
}
