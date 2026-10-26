// Métadonnées JPEG : lecture EXIF (date, appareil), copie EXIF, XMP « photosphère » (GPano).

const XMP_HEADER = 'http://ns.adobe.com/xap/1.0/\0';

function* segmentsOf(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let p = 2;
  while (p + 4 <= bytes.length) {
    if (bytes[p] !== 0xff) return;
    const marker = bytes[p + 1];
    if (marker === 0xda || marker === 0xd9) return;
    const len = (bytes[p + 2] << 8) | bytes[p + 3];
    yield { marker, start: p, end: p + 2 + len };
    p += 2 + len;
  }
}

function isExif(bytes, s) {
  return s.marker === 0xe1 && String.fromCharCode(...bytes.subarray(s.start + 4, s.start + 8)) === 'Exif';
}

// Renvoie le segment APP1 EXIF complet (sans la vignette, qui montrerait l'image d'origine).
export function extractExifSegment(bytes) {
  for (const s of segmentsOf(bytes)) {
    if (!isExif(bytes, s)) continue;
    const seg = bytes.slice(s.start, s.end);
    const tiff = 10;
    const le = seg[tiff] === 0x49;
    const dv = new DataView(seg.buffer);
    const ifd0 = tiff + dv.getUint32(tiff + 4, le);
    if (ifd0 + 2 > seg.length) return seg;
    const n = dv.getUint16(ifd0, le);
    const next = ifd0 + 2 + n * 12;
    if (next + 4 <= seg.length) dv.setUint32(next, 0, le);
    return seg;
  }
  return null;
}

export function readExif(bytes) {
  const info = {};
  for (const s of segmentsOf(bytes)) {
    if (!isExif(bytes, s)) continue;
    const tiff = s.start + 10;
    const dv = new DataView(bytes.buffer, bytes.byteOffset);
    const le = bytes[tiff] === 0x49;
    const str = (off, count) => {
      let r = '';
      for (let i = 0; i < count && bytes[off + i]; i++) r += String.fromCharCode(bytes[off + i]);
      return r.trim();
    };
    const readIfd = (off, wanted) => {
      if (off + 2 > bytes.length) return;
      const n = dv.getUint16(off, le);
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > bytes.length) return;
        const tag = dv.getUint16(e, le);
        const count = dv.getUint32(e + 4, le);
        const valOff = count > 4 ? tiff + dv.getUint32(e + 8, le) : e + 8;
        if (wanted[tag]) wanted[tag](valOff, count, dv.getUint32(e + 8, le));
      }
    };
    try {
      readIfd(tiff + dv.getUint32(tiff + 4, le), {
        0x010f: (o, c) => (info.make = str(o, c)),
        0x0110: (o, c) => (info.model = str(o, c)),
        0x8769: (o, c, v) =>
          readIfd(tiff + v, {
            0x9003: (o2, c2) => (info.dateTimeOriginal = str(o2, c2)),
          }),
      });
    } catch (e) {
      // EXIF corrompu : on ignore
    }
    break;
  }
  if (info.dateTimeOriginal) {
    const m = info.dateTimeOriginal.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (m) info.takenAt = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  }
  return info;
}

export function buildXmpSegment({ width, height, heading = 0, software = 'PhotoSphère' }) {
  const xmp =
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/"' +
    ' GPano:UsePanoramaViewer="True" GPano:ProjectionType="equirectangular"' +
    ` GPano:FullPanoWidthPixels="${width}" GPano:FullPanoHeightPixels="${height}"` +
    ` GPano:CroppedAreaImageWidthPixels="${width}" GPano:CroppedAreaImageHeightPixels="${height}"` +
    ' GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0"' +
    ` GPano:PoseHeadingDegrees="${heading.toFixed(1)}" GPano:InitialViewHeadingDegrees="0"` +
    ` GPano:StitchingSoftware="${software}"/>` +
    '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const payload = new TextEncoder().encode(XMP_HEADER + xmp);
  const len = payload.length + 2;
  const seg = new Uint8Array(len + 2);
  seg.set([0xff, 0xe1, len >> 8, len & 0xff]);
  seg.set(payload, 4);
  return seg;
}

export function readXmp(bytes) {
  for (const s of segmentsOf(bytes)) {
    if (s.marker !== 0xe1) continue;
    const text = new TextDecoder().decode(bytes.subarray(s.start + 4, s.end));
    if (text.startsWith(XMP_HEADER)) return text.slice(XMP_HEADER.length);
  }
  return null;
}
