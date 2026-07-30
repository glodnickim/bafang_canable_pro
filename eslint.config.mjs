import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";

export default defineConfig([
  // Vendored third-party bundles — not ours to fix, and 430+ of their findings
  // drowned out the handful that come from this project's own code.
  { ignores: ["ui/plotly-*.js", "ui/tailwind.js", "dist/**", "releases/**"] },
  { files: ["**/*.{js,mjs,cjs}"], plugins: { js }, extends: ["js/recommended"], languageOptions: { globals: {...globals.browser, ...globals.node} }, rules: { "no-unused-vars": "off", "no-constant-binary-expression": "off" } },
  { files: ["**/*.js"], languageOptions: { sourceType: "commonjs" }, rules: { "no-unused-vars": "off", "no-constant-binary-expression": "off" } },
  { files: ["ui/js/**/*.js"], languageOptions: { sourceType: "module", globals: {...globals.browser} }, rules: { "no-unused-vars": "off" } },
]);
