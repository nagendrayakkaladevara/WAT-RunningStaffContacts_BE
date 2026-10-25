const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const db = new PGlite();
// Run the actual service's Prisma SQL against isolated PostgreSQL, never production.
global.prisma = { $queryRaw: async sql => (await db.query(sql.text, sql.values)).rows };
const { contactService } = require('../dist/services/contact.service');
after(() => db.close());
test('normalized name search preserves matching, counts and pagination', async () => {
  await db.exec('CREATE TABLE contacts (id text, name text)');
  await db.query('INSERT INTO contacts VALUES ($1,$2),($3,$4),($5,$6)', ['1','A.K.Biswas','2','A K Biswas','3','Another Person']);
  for (const query of ['Ak bi', 'A k bi', 'A.k.b', '  AK  BI  ', 'ak-bi', 'Biswas']) {
    const result = await contactService.searchByName(query, 1, 50);
    assert.deepEqual(result.data.map(row => row.id).sort(), ['1','2'], query);
    assert.equal(result.pagination.total, 2);
  }
  const first = await contactService.searchByName('akbi', 1, 1);
  const second = await contactService.searchByName('akbi', 2, 1);
  assert.notEqual(first.data[0].id, second.data[0].id);
  assert.equal(second.pagination.totalPages, 2);
  assert.equal((await contactService.searchByName('akbi', 3, 1)).data.length, 0);
  for (const query of ['...', '   ', '%_', "'; DROP TABLE contacts;--", 'no match']) {
    const result = await contactService.searchByName(query);
    assert.equal(result.data.length, 0, query);
    assert.equal(result.pagination.total, 0, query);
  }
  assert.equal((await db.query('SELECT count(*) FROM contacts')).rows[0].count, 3);
});
