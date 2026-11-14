import { test } from 'node:test';
import assert from 'node:assert/strict';
import { photoRoom, placeRooms, guessRoomName, rectCorners, cornerXZ } from '../src/room.js';

const DEG = Math.PI / 180;
// Pièce 4 × 5 m tournée de 20°, centre (0, 0) ; plafond à 2,8 m. Coins du plafond vus d'un appareil
// placé en (px, pz) à hauteur camH : cap et élévation.
const ROOM = { cx: 0, cz: 0, phi: 20 * DEG, w: 4, l: 5 };
function view(px, pz, camH, H = 2.8) {
  const corners = rectCorners(ROOM).map(([x, z]) => {
    const dx = x - px, dz = z - pz;
    return { yaw: Math.atan2(dx, dz) / DEG, pitch: Math.atan((H - camH) / Math.hypot(dx, dz)) / DEG };
  });
  // Coin au sol sous le premier coin.
  const [x0, z0] = rectCorners(ROOM)[0];
  const floor = { yaw: Math.atan2(x0 - px, z0 - pz) / DEG, pitch: -Math.atan(camH / Math.hypot(x0 - px, z0 - pz)) / DEG };
  return { corners, floor };
}

test('pièce : dimensions et position de l’appareil d’après les 4 coins du plafond', () => {
  const v = view(1, -0.8, 1.6);
  const r = photoRoom({ corners: v.corners, camH: 1.6 }, 2.8);
  const dims = [r.rect.w, r.rect.l].sort();
  assert.ok(Math.abs(dims[0] - 4) < 0.01 && Math.abs(dims[1] - 5) < 0.01, 'dimensions ' + dims);
  // Le centre de la pièce, vu de l'appareil, est en (-1, 0,8).
  assert.ok(Math.abs(r.rect.cx + 1) < 0.01 && Math.abs(r.rect.cz - 0.8) < 0.01, `centre ${r.rect.cx}, ${r.rect.cz}`);
});

test('pièce : hauteur de l’appareil d’après un coin au sol', () => {
  const v = view(-0.5, 1.2, 1.45);
  const r = photoRoom({ corners: v.corners, floor: v.floor }, 2.8);
  assert.ok(Math.abs(r.camH - 1.45) < 0.01, 'hauteur ' + r.camH);
  const dims = [r.rect.w, r.rect.l].sort();
  assert.ok(Math.abs(dims[0] - 4) < 0.02 && Math.abs(dims[1] - 5) < 0.02, 'dimensions ' + dims);
});

test('plan : deux photos d’une même pièce placées l’une par rapport à l’autre, murs dessinés', () => {
  const a = view(1, -0.8, 1.6), b = view(-1.2, 1.5, 1.6);
  const photos = [
    { id: 'a', name: 'salon 1', room: { name: 'Salon', corners: a.corners, camH: 1.6 } },
    { id: 'b', name: 'salon 2', room: { name: 'salon ', corners: b.corners, camH: 1.6 } },
    { id: 'c', name: 'sans pièce' },
  ];
  const res = placeRooms(photos, { ceilingH: 2.8, pxPerM: 50 });
  const pa = res.positions.get('a'), pb = res.positions.get('b');
  // Écart attendu : (-2,2 ; +2,3) m, soit sur le plan (y vers le sud) : (-110 ; -115) px.
  assert.ok(Math.abs(pb.x - pa.x + 110) < 1 && Math.abs(pb.y - pa.y + 115) < 1, `écart ${pb.x - pa.x}, ${pb.y - pa.y}`);
  assert.equal(res.rooms.length, 1);
  const dims = [res.rooms[0].w, res.rooms[0].l].sort();
  assert.ok(Math.abs(dims[0] - 4) < 0.01 && Math.abs(dims[1] - 5) < 0.01);
  assert.deepEqual(res.pairs, [['a', 'b']]);
  assert.ok(!res.positions.has('c'));
});

test('pièce : nom proposé d’après le nom de la photo', () => {
  assert.equal(guessRoomName('360_0887 entrée 1-1'), 'entrée');
  assert.equal(guessRoomName('360_0884 salle à manger 1'), 'salle à manger');
  assert.equal(guessRoomName('360_0881'), '');
  assert.ok(Array.isArray(cornerXZ({ yaw: 0, pitch: 45 })));
});
