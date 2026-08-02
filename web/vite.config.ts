import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-oxc";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import { minimal2023Preset } from "@vite-pwa/assets-generator/config";

// The nadi mark sits on a dark-navy rounded square; #07073f is the logo's
// darkest gradient stop. We fill the maskable/apple icon backgrounds with it so
// Android's squircle/circle crop (and iOS's rounded rect) never reveal
// transparent corners, and use it as the launch splash background too.
const ICON_NAVY = "#07073f";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // Shell-precaching PWA. The service worker (src/sw.ts) is hand-written
      // (injectManifest) because it must ALSO carry the push handlers: two
      // workers cannot share scope "/", and a PushSubscription belongs to its
      // registration, so a second worker would evict push. It precaches the
      // built shell only — realtime chat, /api, /agents, /think-agents and the
      // /live WebSocket are never cached and always hit the network.
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      // The worker is the app's single update mechanism (skipWaiting +
      // clientsClaim in sw.ts, reload-on-activate in main.tsx). Registration is
      // done by hand there so we can also poll for updates on focus.
      registerType: "autoUpdate",
      injectRegister: null,
      injectManifest: {
        // Shell only: hashed JS/CSS, index.html, fonts, icons. NOT
        // `webmanifest` — the plugin precaches the manifest it generates, and a
        // glob that also matches it makes two entries for the same URL with
        // different revisions, which throws add-to-cache-list-conflicting-entries
        // at install time and leaves the worker unregistered (no offline at all).
        globPatterns: ["**/*.{js,css,html,woff2,svg,png,ico}"],
        globIgnores: [
          // Social-card image; never needed by the running app.
          "og.png",
          // Shiki's lazy per-language grammar/theme chunks (~10 MB across
          // ~280 files, routed into assets/shiki-grammar/** by the
          // manualChunks config in `build` above). NOT the shiki engine
          // itself (assets/shiki-engine/**), which stays precached — see the
          // comment on manualChunks for why. A code block in an uncached
          // language just won't highlight offline and is fetched from the
          // network on demand.
          "assets/shiki-grammar/**",
        ],
        // Headroom above Workbox's 2 MiB default so a growing main bundle
        // (currently ~1.5 MB) doesn't get silently dropped from the precache.
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
      },
      pwaAssets: {
        image: "public/nadi-logo.svg",
        // Don't inject a static theme-color meta — index.html already manages
        // one dynamically from the persisted `nadi-theme` setting.
        injectThemeColor: false,
        preset: {
          ...minimal2023Preset,
          maskable: {
            ...minimal2023Preset.maskable,
            // Source SVG already has generous internal margin, so no extra
            // padding is needed to stay inside the maskable safe zone.
            padding: 0,
            resizeOptions: { background: ICON_NAVY },
          },
          apple: {
            ...minimal2023Preset.apple,
            padding: 0,
            resizeOptions: { background: ICON_NAVY },
          },
        },
      },
      manifest: {
        id: "/",
        name: "Nadi",
        short_name: "Nadi",
        description:
          "Nadi is the workspace: agents that work in parallel, a sandbox they can run code in, work they can schedule. You bring the brain, on your own key.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        lang: "en",
        // theme_color tints the running app UI (light by default); the splash
        // uses the dark navy background to match the app icon.
        theme_color: "#f4efe6",
        background_color: ICON_NAVY,
      },
    }),
  ],
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      output: {
        // Shiki's ~340 lazy per-language grammar / theme chunks (~10 MB) get
        // default per-module chunk names indistinguishable from real app
        // chunks (e.g. "cpp", "python", "module"). Route @shikijs/langs and
        // @shikijs/themes modules into "assets/shiki-grammar/**" so the SW
        // precache glob (see VitePWA below) can exclude just that directory
        // by a stable, name-collision-proof pattern. This must NOT catch
        // @shikijs/core or @shikijs/engine-oniguruma: those are the
        // highlighter engine itself, lazily loaded the first time ANY code
        // block renders (tool-call JSON, approval gates) — genuinely part of
        // the shell's runtime, not "a language that might not be used".
        // Verified live: excluding them left the app blank offline because
        // the very first code block's render effect threw on the missing
        // chunk. They get their own stable "shiki-engine/**" bucket (not
        // ignored) purely so their filenames stay predictable too. Each
        // module keeps its own chunk (no bundling together), so per-language
        // lazy loading is unchanged.
        manualChunks(id) {
          const grammar = id.match(/[\\/]@shikijs[\\/](langs|themes)[\\/]/);
          const engine = id.match(/[\\/](@shikijs|shiki)[\\/]/);
          if (!grammar && !engine) return undefined;
          const match = grammar ?? engine;
          const rel = id
            .slice(match!.index! + 1)
            .replace(/\.(m?js|ts)x?$/, "")
            // "@" (scoped package names) is left un-encoded by Workbox's
            // precache manifest but gets percent-encoded by some static
            // asset servers, so a request for the literal "@..." URL 307s
            // to "%40..." — a URL Workbox never precached, falling through
            // to the network (and failing offline). Keep filenames to a
            // plain, unencodable charset.
            .replace(/[^A-Za-z0-9._-]+/g, "-");
          return grammar ? `shiki-grammar/${rel}` : `shiki-engine/${rel}`;
        },
      },
    },
  },
  resolve: {
    // Allow web/ to resolve deps from root node_modules (monorepo hoisting)
    dedupe: ["react", "react-dom"],
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
