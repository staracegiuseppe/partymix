import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Entry, PlaylistMeta } from '../../shared/model.ts';
import { apply, diff } from '../../shared/merge.ts';

const e = (id: string): Entry => ({ entryId: id, youtubeId: id, title: `Song ${id}` });
const list = (...ids: string[]) => ids.map(e);
const meta = (name = 'Party', extra: Partial<PlaylistMeta> = {}): PlaylistMeta => ({ name, sortOrder: 0, ...extra });
const ids = (x: { entries: Entry[] }) => x.entries.map((y) => y.entryId);
const doc = (name: string, ...ids: string[]) => ({ meta: meta(name), entries: list(...ids) });

describe('diff', () => {
  test('nulla cambiato = nessuna operazione', () => {
    assert.deepEqual(diff(doc('P', 'A', 'B'), doc('P', 'A', 'B')), []);
  });
  test('aggiunta, rimozione, spostamento, rinomina', () => {
    const ops = diff(doc('P', 'A', 'B', 'C'), doc('Q', 'C', 'A', 'D'));
    assert.deepEqual(ops.map((o) => o.op), ['set', 'remove', 'move', 'add']);
    assert.deepEqual(ops[0], { op: 'set', field: 'name', value: 'Q', was: 'P' });
    assert.deepEqual(ops[1], { op: 'remove', entryId: 'B' });
    assert.equal(ops[2].op, 'move'); // either C to the front or A after C: the same result
    assert.deepEqual(ops[3], { op: 'add', entry: e('D'), after: ['A', 'C'] });
  });
  test('rigiocare il diff dà la lista nuova', () => {
    const base = doc('P', 'A', 'B', 'C', 'D', 'E', 'F');
    const local = doc('P', 'F', 'B', 'X', 'A', 'E', 'Y');
    assert.deepEqual(ids(apply(base, diff(base, local))), ids(local));
  });
});

describe('apply: due dispositivi', () => {
  const base = doc('Party', 'A', 'B', 'C');

  test('§31: telefono offline toglie B e aggiunge D; il PC intanto aggiunge E', () => {
    const phone = doc('Party', 'A', 'D', 'C');
    const pc = doc('Party', 'A', 'B', 'C', 'E');
    const out = apply(pc, diff(base, phone), diff(base, pc));
    assert.deepEqual(ids(out), ['A', 'D', 'C', 'E']);
    assert.deepEqual(out.conflicts, []);
  });

  test('entrambi aggiungono brani diversi: tutti restano', () => {
    const a = doc('Party', 'A', 'B', 'C', 'X');
    const b = doc('Party', 'Y', 'A', 'B', 'C');
    const out = apply(b, diff(base, a), diff(base, b));
    assert.deepEqual(ids(out), ['Y', 'A', 'B', 'C', 'X']);
  });

  test('stesso brano aggiunto da entrambi: una volta sola', () => {
    const a = doc('Party', 'A', 'B', 'C', 'X');
    const b = doc('Party', 'A', 'X', 'B', 'C');
    assert.deepEqual(ids(apply(b, diff(base, a), diff(base, b))), ['A', 'X', 'B', 'C']);
  });

  test('aggiunta dopo un brano che l’altro ha tolto: va dopo il predecessore di quello', () => {
    const a = doc('Party', 'A', 'B', 'X', 'C');
    const b = doc('Party', 'A', 'C');
    assert.deepEqual(ids(apply(b, diff(base, a), diff(base, b))), ['A', 'X', 'C']);
  });

  test('rinomina da un lato, brani dall’altro: nessun conflitto', () => {
    const a = doc('Festa', 'A', 'B', 'C');
    const b = doc('Party', 'A', 'B', 'C', 'D');
    const out = apply(b, diff(base, a), diff(base, b));
    assert.equal(out.meta.name, 'Festa');
    assert.deepEqual(ids(out), ['A', 'B', 'C', 'D']);
    assert.deepEqual(out.conflicts, []);
  });

  test('stesso campo cambiato in due modi: conflitto, resta il valore già sul NAS', () => {
    const a = doc('Festa', 'A', 'B', 'C');
    const b = doc('Palestra', 'A', 'B', 'C');
    const out = apply(b, diff(base, a), diff(base, b));
    assert.equal(out.meta.name, 'Palestra');
    assert.deepEqual(out.conflicts, [{ field: 'name', mine: 'Festa', theirs: 'Palestra' }]);
  });

  test('stesso campo, stesso valore: nessun conflitto', () => {
    const a = doc('Festa', 'A', 'B', 'C');
    const out = apply(a, diff(base, a), diff(base, a));
    assert.deepEqual(out.conflicts, []);
  });

  test('tolto da uno, spostato dall’altro: resta tolto', () => {
    const a = doc('Party', 'A', 'C');
    const b = doc('Party', 'B', 'A', 'C');
    assert.deepEqual(ids(apply(b, diff(base, a), diff(base, b))), ['A', 'C']);
  });

  test('tolto da uno e intanto rimesso dall’altro: l’aggiunta non riporta ciò che è stato tolto', () => {
    const a = doc('Party', 'A', 'B', 'C', 'B2');
    const b = doc('Party', 'A', 'C');
    const out = apply(b, diff(base, a), diff(base, b));
    assert.deepEqual(ids(out), ['A', 'C', 'B2']);
  });

  test('descrizione tolta da un lato', () => {
    const b0 = { meta: meta('P', { description: 'vecchia' }), entries: list('A') };
    const a = { meta: meta('P'), entries: list('A') };
    const out = apply(b0, diff(b0, a));
    assert.equal(out.meta.description, undefined);
    assert.ok(!('description' in out.meta));
  });
});
