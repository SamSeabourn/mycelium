// cytoscape-fcose ships no types; the plugin is registered and then referenced by
// layout name, so a minimal declaration is all this needs.
declare module 'cytoscape-fcose' {
  import type { Ext } from 'cytoscape';
  const ext: Ext;
  export default ext;
}
