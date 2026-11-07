import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSettings } from '../src/settings-file.js';

test('fichier de réglages : liens désignés par nom de fichier', () => {
  const photos = [
    { id: 'a', fileName: 'SAM_0001.JPG', fileSize: 10, name: 'Entrée', srcType: 'fisheye', params: { yaw: 12, pitch: 1, roll: -2 }, hotspots: [{ id: 'h', target: 'b', yaw: 30, pitch: -5, label: 'Salon' }] },
    { id: 'b', fileName: 'SAM_0002.JPG', fileSize: 20, name: 'Salon', srcType: 'fisheye', params: { yaw: 0, pitch: 0, roll: 0 }, hotspots: [{ id: 'x', target: 'disparue', yaw: 0, pitch: 0 }] },
  ];
  const s = buildSettings(photos);
  assert.equal(s.format, 'photosphere-reglages');
  assert.equal(s.photos[0].file, 'SAM_0001.JPG');
  assert.deepEqual(s.photos[0].hotspots, [{ target: 'SAM_0002.JPG', yaw: 30, pitch: -5, label: 'Salon' }]);
  assert.equal(s.photos[1].hotspots.length, 0, 'un lien vers une photo absente est ignoré');
  assert.equal(s.photos[0].params.yaw, 12);
  assert.ok(JSON.stringify(s).length < 2000);
});
