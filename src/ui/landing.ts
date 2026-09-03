import type { Route } from "../main";

/**
 * The hub. A card per tool, pick one. Deliberately spare — it's a lobby, not a
 * landing page. Everything the tools promise (on-device, no upload) is stated
 * once here so no tool has to repeat it.
 */

interface ToolCard {
  route: Route;
  name: string;
  tagline: string;
  blurb: string;
  glyph: string; // one pixel-ish glyph, drawn large
}

const TOOLS: ToolCard[] = [
  {
    route: "silhouette",
    name: "silhouette",
    tagline: "cut a subject out of any image",
    blurb:
      "Auto-segment with an on-device matting model, refine by hand with an add/erase brush, export PNG · SVG · traced silhouette.",
    glyph: "◑",
  },
  {
    route: "grainery",
    name: "grainery",
    tagline: "make a pixelated image pleasant again",
    blurb:
      "Upscale in linear light, then buy the detail back with film-grade blue-noise grain. Runs live on the GPU, exports PNG · JPEG.",
    glyph: "▚",
  },
  {
    route: "halftone",
    name: "halftone",
    tagline: "rebuild an image out of comic ink dots",
    blurb:
      "A rigid grid of black circles, each sized by the darkness underneath it. Tune the screen, threshold it into comic territory, export PNG at up to 4×.",
    glyph: "⣿",
  },
];

export function mountLanding(root: HTMLElement, navigate: (route: Route) => void): void {
  root.innerHTML = `
    <div class="hub">
      <header class="hub-head">
        <h1 class="hub-title">studio</h1>
        <p class="hub-sub">on-device image tools — nothing leaves your browser</p>
      </header>
      <div class="hub-grid">
        ${TOOLS.map(
          (t) => `
          <button class="hub-card" data-route="${t.route}">
            <div class="hub-card-glyph">${t.glyph}</div>
            <div class="hub-card-name">${t.name}</div>
            <div class="hub-card-tagline">${t.tagline}</div>
            <p class="hub-card-blurb">${t.blurb}</p>
            <span class="hub-card-go">open →</span>
          </button>`,
        ).join("")}
      </div>
      <footer class="hub-foot">
        <span>&gt; no uploads · no accounts · no tracking</span>
        <a href="https://github.com/chakri68" target="_blank" rel="noopener">chakri68</a>
      </footer>
    </div>
  `;

  root.querySelectorAll<HTMLButtonElement>(".hub-card").forEach((card) => {
    card.addEventListener("click", () => navigate(card.dataset.route as Route));
  });
}
