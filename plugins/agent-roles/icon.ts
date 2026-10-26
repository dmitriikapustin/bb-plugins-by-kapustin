// Role icon checks (server only).
//
// A role icon is a PNG data URL. The editor scales any picked image to a
// small non-interlaced PNG in the browser. The server does not decode pixels;
// it checks the structure and size: valid base64, the PNG signature, every
// chunk's CRC, one valid IHDR first, no unknown critical chunks, a palette
// when the colour type needs one, at least one IDAT, an empty IEND last, and
// image data that decompresses to exactly the rows the header declares, each
// starting with a valid filter byte. Interlaced images are not accepted.
import { inflateSync } from "node:zlib";
import { MAX_ICON_DATA_URL } from "./shared.ts";

export const ICON_PREFIX = "data:image/png;base64,";
/** Maximum width and height in pixels. Larger than the editor's own output, for icons set through the RPC. */
export const MAX_ICON_SIDE = 256;

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// Allowed bit depths for each colour type (PNG specification, table 11.1).
const BIT_DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Why `value` is not an acceptable role icon, or null when it is. */
export function iconProblem(value: string): string | null {
  if (value.length > MAX_ICON_DATA_URL) return `must be at most ${MAX_ICON_DATA_URL} characters`;
  if (!value.startsWith(ICON_PREFIX)) return "must be a PNG data URL";
  const base64 = value.slice(ICON_PREFIX.length);
  if (base64.length === 0 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    return "is not valid base64";
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length < SIGNATURE.length || !bytes.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    return "is not a PNG image";
  }

  let offset = SIGNATURE.length;
  let header: Buffer | null = null;
  let palette = false;
  let ended = false;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    if (ended) return "has data after the end of the image";
    if (offset + 12 > bytes.length) return "is truncated";
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return "is truncated";
    const type = bytes.toString("latin1", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== bytes.readUInt32BE(offset + 8 + length)) {
      return `has a corrupt ${type} chunk`;
    }
    if (!header) {
      if (type !== "IHDR" || length !== 13) return "does not start with an image header";
      header = body;
    } else if (type === "IHDR") {
      return "has more than one image header";
    } else if (type === "PLTE") {
      palette = true;
    } else if (type === "IDAT") {
      data.push(body);
    } else if (type === "IEND") {
      if (length !== 0) return "has a malformed end chunk";
      ended = true;
    } else if (!/^[a-z]/.test(type) && !CRITICAL.has(type)) {
      return `has an unsupported ${type} chunk`;
    }
    offset = end;
  }
  if (!header || !ended) return "is truncated";
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [depth, colorType, compression, filter, interlace] = [header[8]!, header[9]!, header[10]!, header[11]!, header[12]!];
  if (width < 1 || height < 1 || width > MAX_ICON_SIDE || height > MAX_ICON_SIDE) {
    return `must be at most ${MAX_ICON_SIDE}×${MAX_ICON_SIDE} pixels`;
  }
  if (!BIT_DEPTHS[colorType]?.includes(depth) || compression !== 0 || filter !== 0) return "has an invalid image header";
  if (interlace !== 0) return "must not be interlaced";
  if (colorType === 3 && !palette) return "has no palette";
  if (data.length === 0) return "has no image data";

  const rowBytes = 1 + Math.ceil((width * CHANNELS[colorType]! * depth) / 8);
  const expected = height * rowBytes;
  let pixels: Buffer;
  try {
    // One byte of headroom, so data longer than the header allows is detected rather than cut off.
    pixels = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 });
  } catch {
    return "has image data that does not decompress to the declared size";
  }
  if (pixels.length !== expected) return "has image data that does not decompress to the declared size";
  for (let row = 0; row < expected; row += rowBytes) {
    if (pixels[row]! > 4) return "has an invalid row filter";
  }
  return null;
}
