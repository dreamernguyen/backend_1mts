const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTransactionDraft } = require('../src/services/receipt-normalizer.service');

test('receipt midnight in Vietnam does not shift to the previous UTC day', () => {
    const normalize = date => normalizeTransactionDraft({ date, amount: 60000, category: 'DINING', items: [] }).date;
    assert.equal(normalize('2026-10-08T00:00:00+07:00'), '2026-10-07T17:00:00.000Z');
    assert.equal(normalize('2026-10-07T17:00:00.000Z'), '2026-10-07T17:00:00.000Z');
    assert.equal(normalize('2026-10-07T16:59:59.999Z'), '2026-10-07T16:59:59.999Z');
    assert.equal(normalize('2026-10-08T21:30:01+07:00'), '2026-10-08T14:30:01.000Z');
    assert.equal(normalize('2026-10-08T21:30:01'), '2026-10-08T14:30:01.000Z');
    assert.equal(normalize('2026-10-08'), '2026-10-08');
});
