import { describe, expect, it } from 'vitest';
import { equal, fromBase64, toBase64 } from '../src/bytes';

describe('bounded byte utilities', () => {
  it('round-trips every byte value, empty content and padding boundaries', () => {
    for (const length of [0, 1, 2, 3, 255, 256, 257, 8191, 8192, 8193]) {
      const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
      expect(equal(fromBase64(toBase64(bytes)), bytes)).toBe(true);
    }
  });
  it('compares bytes and views without callbacks or lossy text conversion', () => {
    const data = Uint8Array.of(0, 255, 1, 128, 3);
    expect(equal(null, null)).toBe(true);
    expect(equal(null, data)).toBe(false);
    expect(equal(data, null)).toBe(false);
    expect(equal(data, data.slice())).toBe(true);
    expect(equal(data.subarray(1, 4), Uint8Array.of(255, 1, 128))).toBe(true);
    expect(equal(data, Uint8Array.of(0, 255, 2, 128, 3))).toBe(false);
    expect(equal(data, data.subarray(0, 4))).toBe(false);
  });
});
