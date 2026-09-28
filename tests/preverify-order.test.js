'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPreverifyOrder } = require('../server/preverify-order');

function rows(prefix, n, opts = {}) {
  return Array.from({ length: n }, (_, i) => ({
    base_name: `${prefix}${i}`,
    auction_end: opts.dated ? new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString() : null,
    priority: opts.priority ? i : undefined,
  }));
}

test('streams interleave with a fair share; a huge closeout stream never starves auctions', () => {
  const order = buildPreverifyOrder({
    'godaddy-closeout': rows('c', 1000),
    'godaddy-auction': rows('a', 10, { dated: true }),
    'namecheap-auction': rows('n', 10, { dated: true }),
  });
  assert.equal(order.length, 1020);
  const first30 = order.slice(0, 30).map(r => r.stream);
  assert.equal(first30.filter(s => s === 'godaddy-closeout').length, 10);
  assert.equal(first30.filter(s => s === 'godaddy-auction').length, 10);
  assert.equal(first30.filter(s => s === 'namecheap-auction').length, 10);
  // Auctions are exhausted after 30, closeouts continue without gaps.
  assert.ok(order.slice(30).every(r => r.stream === 'godaddy-closeout'));
});

test('a huge auction stream never starves closeouts either', () => {
  const order = buildPreverifyOrder({
    'godaddy-auction': rows('a', 5000, { dated: true }),
    'godaddy-closeout': rows('c', 20),
  });
  const first40 = order.slice(0, 40).map(r => r.stream);
  assert.equal(first40.filter(s => s === 'godaddy-closeout').length, 20);
});

test('within a stream: soonest end first, undated after dated, then display priority, then name', () => {
  const order = buildPreverifyOrder({
    s: [
      { base_name: 'undated-z' },
      { base_name: 'late', auction_end: '2026-10-02T00:00:00Z' },
      { base_name: 'soon', auction_end: '2026-10-01T00:00:00Z' },
      { base_name: 'undated-b', priority: 2 },
      { base_name: 'undated-a', priority: 1 },
      { base_name: 'expiring', expiry: '2026-09-30T00:00:00Z' },
    ],
  });
  assert.deepEqual(order.map(r => r.base_name), ['expiring', 'soon', 'late', 'undated-a', 'undated-b', 'undated-z']);
});

test('shares weight the interleave, max bounds the output, exclude skips receipted names, dupes emit once', () => {
  const order = buildPreverifyOrder({
    big: rows('b', 100),
    small: rows('s', 100),
  }, { shares: { big: 3, small: 1 }, max: 40, exclude: new Set(['b0', 's0']) });
  assert.equal(order.length, 40);
  assert.equal(order.filter(r => r.stream === 'big').length, 30);
  assert.equal(order.filter(r => r.stream === 'small').length, 10);
  assert.ok(!order.some(r => r.base_name === 'b0' || r.base_name === 's0'));

  const dupes = buildPreverifyOrder({
    a: [{ base_name: 'Widget', auction_end: '2026-10-01T00:00:00Z' }],
    b: [{ base_name: 'widget' }],
  });
  assert.deepEqual(dupes, [{ base_name: 'widget', stream: 'a', auction_end: '2026-10-01T00:00:00Z' }]);
});

test('empty and malformed input yields an empty order', () => {
  assert.deepEqual(buildPreverifyOrder({}), []);
  assert.deepEqual(buildPreverifyOrder({ s: [{ base_name: '' }, null] }), []);
});
