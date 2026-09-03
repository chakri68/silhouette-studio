import "./styles.css";
import { mountLanding } from "./ui/landing";

/**
 * App shell + hash router.
 *
 * The site is a small hub of independent, on-device image tools. Each tool owns
 * its own full-screen "route screen" and is mounted lazily on first navigation
 * via a dynamic import — so opening Grainery never pays for the silhouette
 * segmentation model, and vice versa. Once mounted a screen is kept alive and
 * just toggled with `.hidden`; tools hold internal state (loaded image, WebGL
 * context) that we don't want to tear down on every route change.
 */

export type Route = "hub" | "silhouette" | "grainery" | "halftone";

const app = document.querySelector<HTMLDivElement>("#app")!;
app.innerHTML = `
  <div class="intro" id="intro">
    <h1 class="intro-title">studio</h1>
  </div>
  <div class="route-screen hidden" id="screen-hub"></div>
  <div class="route-screen hidden" id="screen-silhouette"></div>
  <div class="route-screen hidden" id="screen-grainery"></div>
  <div class="route-screen hidden" id="screen-halftone"></div>
`;

const screens: Record<Route, HTMLElement> = {
  hub: document.getElementById("screen-hub")!,
  silhouette: document.getElementById("screen-silhouette")!,
  grainery: document.getElementById("screen-grainery")!,
  halftone: document.getElementById("screen-halftone")!,
};

const mounted: Record<Route, boolean> = {
  hub: false,
  silhouette: false,
  grainery: false,
  halftone: false,
};

function parseRoute(): Route {
  const h = location.hash.replace(/^#\/?/, "");
  return h === "silhouette" || h === "grainery" || h === "halftone" ? h : "hub";
}

export function navigate(route: Route): void {
  location.hash = route === "hub" ? "#/" : `#/${route}`;
}

async function show(route: Route): Promise<void> {
  if (!mounted[route]) {
    mounted[route] = true; // set first: mount is async, guard against double-entry
    try {
      if (route === "hub") mountLanding(screens.hub, navigate);
      else if (route === "silhouette")
        (await import("./tools/silhouette/index")).mountSilhouette(screens.silhouette, navigate);
      else if (route === "halftone")
        (await import("./tools/halftone/index")).mountHalftone(screens.halftone, navigate);
      else (await import("./tools/grainery/index")).mountGrainery(screens.grainery, navigate);
    } catch (err) {
      mounted[route] = false;
      console.error(`failed to mount ${route}:`, err);
    }
  }

  for (const key of Object.keys(screens) as Route[]) {
    screens[key].classList.toggle("hidden", key !== route);
  }
  document.title = TITLES[route];
  // Canvas-based tools size themselves off clientWidth, which is 0 while hidden.
  // Kick a resize now that the screen is visible so they lay out correctly.
  window.dispatchEvent(new Event("resize"));
}

const TITLES: Record<Route, string> = {
  hub: "studio — on-device image tools",
  silhouette: "silhouette — browser image cutout & silhouette tool",
  grainery: "grainery — de-pixelate & grain, in your browser",
  halftone: "halftone — comic dot renderer, in your browser",
};

window.addEventListener("hashchange", () => void show(parseRoute()));
void show(parseRoute());

// Boot splash: the intro overlay ships in the DOM from first paint so nothing
// flashes unstyled. `body.booted` (added once the pixel font is ready) runs the
// title's fade+glow, then it dissolves and the hub reveals underneath.
const intro = document.getElementById("intro")!;
intro.addEventListener("animationend", () => intro.classList.add("hidden"), { once: true });
const boot = (): void => document.body.classList.add("booted");
document.fonts?.ready.then(boot).catch(boot);
setTimeout(boot, 1500); // fallback if font loading stalls
