// Archives ZIP « stockées » (sans compression : les JPEG sont déjà compressés).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return new Uint8Array(await data.arrayBuffer());
}

// files : [{ name, data: Blob | Uint8Array | string }]
export async function createZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  for (const f of files) {
    const data = await toBytes(f.data);
    const name = new TextEncoder().encode(f.name);
    const crc = crc32(data);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);
    h.setUint16(6, 0x0800, true);
    h.setUint16(8, 0, true);
    h.setUint16(10, time, true);
    h.setUint16(12, date, true);
    h.setUint32(14, crc, true);
    h.setUint32(18, data.length, true);
    h.setUint32(22, data.length, true);
    h.setUint16(26, name.length, true);
    h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, data.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    central.push(new Uint8Array(c.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((s, p) => s + p.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true);
  e.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}

// Lit une archive ZIP non compressée. Renvoie [{ name, blob }].
export async function readZip(blob) {
  const tailSize = Math.min(blob.size, 65557);
  const tail = new Uint8Array(await blob.slice(blob.size - tailSize).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Archive ZIP invalide');
  const count = tv.getUint16(eocd + 10, true);
  const cdSize = tv.getUint32(eocd + 12, true);
  const cdOff = tv.getUint32(eocd + 16, true);
  const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const cv = new DataView(cd.buffer);
  const out = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (cv.getUint32(p, true) !== 0x02014b50) throw new Error('Répertoire ZIP invalide');
    const method = cv.getUint16(p + 10, true);
    const size = cv.getUint32(p + 20, true);
    const nameLen = cv.getUint16(p + 28, true);
    const extraLen = cv.getUint16(p + 30, true);
    const commentLen = cv.getUint16(p + 32, true);
    const local = cv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nameLen));
    if (method !== 0) throw new Error('Fichier compressé non pris en charge : ' + name);
    const lh = new DataView(await blob.slice(local, local + 30).arrayBuffer());
    const start = local + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
    out.push({ name, blob: blob.slice(start, start + size) });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
