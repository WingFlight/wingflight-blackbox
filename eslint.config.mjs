import globals from "globals";
import pluginJs from "@eslint/js";

/** @type {import('eslint').Linter.Config[]} */
export default [
  {
    ignores: ["js/vendor/**", "dist/**", "apps/**", "debug/**", "release/**", "dev-client/**", "cache/**", "changelog.html"],
  },
  {
    languageOptions: {
      ecmaVersion: "latest",
      // ESLint's flat-config default is sourceType: "module", which gives every top-level
      // declaration its own per-file module scope. These are plain <script>-tag files with
      // no import/export, sharing one real global scope across the page (jQuery-style),
      // so "script" is what actually matches -- and it's what makes the no-unused-vars
      // "local" setting below do anything at all (under "module" it still flagged every
      // top-level function/class as unused, since module scope doesn't count as "global").
      sourceType: "script",
      globals: { ...globals.browser, ...globals.node, ...globals.jquery },
    },
  },
  {
    // The actual ES modules in this repo (build tooling config, not app code).
    files: ["**/*.mjs"],
    languageOptions: {
      sourceType: "module",
    },
  },
  pluginJs.configs.recommended,
  {
    rules: {
      semi: "error",
      "no-prototype-builtins": "off",
      "no-unused-vars": [
        "error",
        {
          // "local": only flag unused *local* (function-scope) variables, not top-level
          // ones -- in these non-module <script> files, a top-level `function`/`class`/`var`
          // is that file's public API for every other script sharing the same global scope
          // (e.g. js/sticks.js's top-level `class FlightLogSticks` is `new`'d from
          // js/main.js), not dead code. Same underlying reason as the no-undef TODO below.
          vars: "local",
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],

      // TODO: This codebase is 41 global-scope <script> files (no import/export -- see
      // vite.config.mjs's own notes on this), so nearly everything is a cross-file global by
      // design, same situation wingflight-configurator's own eslint.config.mjs already
      // disables this for. Revisit once/if the ES modules conversion mentioned there happens.
      "no-undef": "off",
    },
  },
];
