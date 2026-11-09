import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesSearch } from '../src/ui.js';

test('recherche : casse, accents et plusieurs mots', () => {
  assert.ok(matchesSearch('entree', 'Entrée du jardin', 'SAM_0001.JPG'));
  assert.ok(matchesSearch('JARDIN entrée', 'Entrée du jardin'));
  assert.ok(matchesSearch('0001', 'Entrée du jardin', 'SAM_0001.JPG'), 'recherche aussi dans le nom de fichier');
  assert.ok(!matchesSearch('cuisine', 'Entrée du jardin', 'SAM_0001.JPG'));
  assert.ok(!matchesSearch('entree cuisine', 'Entrée du jardin'));
  assert.ok(matchesSearch('   ', 'n’importe quoi'), 'recherche vide : tout correspond');
});
