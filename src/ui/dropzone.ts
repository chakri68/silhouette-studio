/**
 * Empty-state drop zone + file picker. Decodes an upload into an oriented
 * ImageBitmap (EXIF-corrected) and caps its longest side to keep brushing/
 * compositing smooth later. Hands the bitmap back via `onImage`.
 */

const MAX_SIDE = 2048; // working-resolution cap; full-res export comes later.

interface DropzoneEls {
  dropzone: HTMLElement;
  fileInput: HTMLInputElement;
  openButton: HTMLElement;
}

export function initDropzone(
  els: DropzoneEls,
  onImage: (bmp: ImageBitmap, name: string) => void,
): void {
  const { dropzone, fileInput, openButton } = els;

  const pick = () => fileInput.click();
  dropzone.addEventListener("click", pick);
  openButton.addEventListener("click", pick);

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) void handle(file);
    fileInput.value = ""; // allow re-picking the same file
  });

  // Drag & drop over the whole screen well.
  const stop = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
  };
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      stop(e);
      dropzone.classList.add("dragging");
    }),
  );
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      stop(e);
      dropzone.classList.remove("dragging");
    }),
  );
  dropzone.addEventListener("drop", (e) => {
    const file = (e as DragEvent).dataTransfer?.files?.[0];
    if (file) void handle(file);
  });

  // Paste an image from the clipboard (Cmd/Ctrl+V). Bound to the window, not the
  // dropzone (it can't hold focus), so we gate on the tool's route screen being
  // visible — otherwise a paste would load into every mounted-but-hidden tool.
  window.addEventListener("paste", (e: ClipboardEvent) => {
    if (dropzone.closest(".route-screen")?.classList.contains("hidden")) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === "file" && it.type.startsWith("image/")) {
        const file = it.getAsFile();
        if (file) {
          e.preventDefault();
          void handle(file);
          return;
        }
      }
    }
  });

  async function handle(file: File): Promise<void> {
    setError(dropzone, null);
    if (!file.type.startsWith("image/")) {
      setError(dropzone, "not an image file");
      return;
    }
    try {
      const bmp = await decode(file);
      onImage(bmp, file.name);
    } catch (err) {
      console.error(err);
      setError(dropzone, "couldn't decode that image");
    }
  }
}

async function decode(file: Blob): Promise<ImageBitmap> {
  let bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
  const longest = Math.max(bmp.width, bmp.height);
  if (longest > MAX_SIDE) {
    const s = MAX_SIDE / longest;
    const resized = await createImageBitmap(bmp, {
      resizeWidth: Math.round(bmp.width * s),
      resizeHeight: Math.round(bmp.height * s),
      resizeQuality: "high",
    });
    bmp.close();
    bmp = resized;
  }
  return bmp;
}

function setError(dropzone: HTMLElement, msg: string | null): void {
  const sub = dropzone.querySelector<HTMLElement>(".dz-sub");
  if (!sub) return;
  if (msg) {
    sub.textContent = msg;
    sub.classList.add("error");
  } else {
    sub.classList.remove("error");
    sub.textContent = "click to browse, or paste — png · jpg · webp · gif · bmp";
  }
}
