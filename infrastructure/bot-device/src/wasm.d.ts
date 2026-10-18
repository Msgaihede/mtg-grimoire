/**
 * A `.wasm` import is a compiled `WebAssembly.Module` in workerd — wrangler's `CompiledWasm`
 * rule, its default for the extension.
 */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
