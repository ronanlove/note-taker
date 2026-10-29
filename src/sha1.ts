// Plain-JS SHA-1, because crypto.subtle only exists on HTTPS pages and the dev server is plain HTTP on the LAN.

export function sha1(bytes: Uint8Array): string {
  const total = ((bytes.length + 9 + 63) >> 6) << 6;
  const buf = new Uint8Array(total);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = bytes.length * 8;
  view.setUint32(total - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(total - 4, bits >>> 0);

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) {
      const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
      w[i] = (x << 1) | (x >>> 31);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      const f =
        i < 20 ? ((b & c) | (~b & d)) + 0x5a827999
        : i < 40 ? (b ^ c ^ d) + 0x6ed9eba1
        : i < 60 ? ((b & c) | (b & d) | (c & d)) + 0x8f1bbcdc
        : (b ^ c ^ d) + 0xca62c1d6;
      const t = (((a << 5) | (a >>> 27)) + f + e + w[i]) | 0;
      e = d;
      d = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = t;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

const encoder = new TextEncoder();

/** The id git gives a file with this content, so we can tell whether our copy matches the remote one. */
export function gitBlobSha(text: string): string {
  const body = encoder.encode(text);
  const header = encoder.encode(`blob ${body.length}\0`);
  const all = new Uint8Array(header.length + body.length);
  all.set(header);
  all.set(body, header.length);
  return sha1(all);
}
