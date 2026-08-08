import { defineConfig } from "vite";

// The app is still plain <script>-tag JS (jQuery/vendored libs, global scope, no
// import/export, no bundler-managed dependency graph) -- this config exists right now
// purely to give a fast local dev server with reload-on-save, replacing the ad-hoc
// `npx serve .` from the first browser-compat pass.
//
// It does NOT yet produce a working `vite build` output. Vite's dev server happily
// proxies plain static requests (node_modules/..., js/vendor/..., _locales/...) the same
// way any static file server would, but its build step only carries through assets it
// finds by walking the module graph from <script type="module">/CSS @import -- our plain
// <script src> tags and node_modules-relative references aren't part of that graph, so a
// build today would emit an index.html missing most of its scripts. Making `vite build`
// produce a deployable bundle is the "web" phase, and will need the kind of asset-copying
// plugins wingflight-configurator's vite.config.mjs uses for its own legacy scripts.
export default defineConfig({
    server: {
        port: 8080,
        strictPort: true,
    },
});
