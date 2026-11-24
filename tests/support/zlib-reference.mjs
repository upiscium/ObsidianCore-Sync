// The published Bridge ZIP hash covers deflate output, which depends on the zlib
// inside the Node binary. The official Node builds used by CI bundle Chromium's
// zlib and compress differently from the toolchain that produced the published
// asset (zlib 1.3.2 as built by nixpkgs). A fixed probe tells the two apart.
// Tests that need the byte-identical Bridge ZIP skip ONLY when CI=true and the
// probe differs; elsewhere a changed compressor fails instead of skipping
// silently. Follow-up: compare entry contents instead of compressed bytes (#2).
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

const REFERENCE_DEFLATE_SHA256 = '0a2d3ad57378ea2efbca42bb8f4148b9b907b8ad11cfc0cca87353e2c3a05510';

function probeDiffers() {
  let text = '';
  let h = 'seed';
  for (let i = 0; i < 400; i++) {
    h = createHash('sha256').update(h).digest('hex');
    text += `line ${i % 37}: ${h.slice(0, 24)} ${h.slice(24, 40)}\n`;
  }
  const out = deflateRawSync(Buffer.from(text), { level: 9 });
  return createHash('sha256').update(out).digest('hex') !== REFERENCE_DEFLATE_SHA256;
}

export const compressorDiffersFromRelease = probeDiffers();
export const skipBridgeByteIdentityInCi = process.env.CI === 'true' && compressorDiffersFromRelease;
