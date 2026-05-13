// SVGO configuration consumed by the build-time Vite plugin in
// `packages/client/vite.config.ts`, which optimises every SVG in the build
// output. Source SVGs are intentionally left untouched in the repo.
//
// `preset-default` runs the standard battery of optimisations. As of SVGO 4
// `removeViewBox` is no longer part of the preset, so `viewBox` is preserved
// out of the box — which is what we want for responsive scaling.
//
// `multipass` keeps re-running optimisations until the output stops shrinking,
// catching simplifications that only become possible after an earlier pass.
export default {
  multipass: true,
  plugins: ['preset-default'],
};
