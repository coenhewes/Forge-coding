/** Internal helpers shared across belief submodules. */

/** Clamp a number to [0, 1], rounded to 2 decimals. NaN → 0. */
export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.max(0, Math.min(1, Number(value.toFixed(2))))
}
