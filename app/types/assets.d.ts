/**
 * Side-effect imports of stylesheets.
 *
 * esbuild bundles these into the emitted renderer.css; TypeScript needs to be
 * told they are legitimate modules rather than a missing import.
 */
declare module '*.css';
