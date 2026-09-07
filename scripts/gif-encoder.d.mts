/**
 * Types for the GIF writer.
 *
 * The encoder itself is plain JavaScript because it is a build script and this
 * project's scripts are not compiled. A declaration file rather than a blanket
 * `@ts-expect-error` at the import, so a signature that changes is still a type
 * error in the tests instead of being silently swallowed by a suppression.
 */

export type Rgb = readonly [number, number, number];

export function quantize(
  pixels: Uint8ClampedArray | Uint8Array,
  maxColours?: number,
): Rgb[];

export function indexPixels(
  pixels: Uint8ClampedArray | Uint8Array,
  palette: readonly Rgb[] | readonly number[][],
): Uint8Array;

export function lzwEncode(indexed: Uint8Array, minimumCodeSize: number): Uint8Array;

export function encodeGif(options: {
  width: number;
  height: number;
  delayMs: number;
  frames: readonly (Uint8ClampedArray | Uint8Array)[];
}): Uint8Array;

export function countGifFrames(bytes: Uint8Array): number;
