// What wrangler's module rules make of the Fairness card image's assets (cardAssets.ts).
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
declare module "*.woff" {
  const bytes: ArrayBuffer;
  export default bytes;
}
