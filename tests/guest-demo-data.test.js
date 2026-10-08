const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { buildDemoData, initializeGuest } = require('../src/services/guest-demo-data.service');
const { balanceFromTransactions, fixedState, cycleDates } = require('../src/services/finance.service');

for (const date of ['2026-10-08T13:00:00Z','2026-10-19T16:59:00Z','2026-10-19T17:00:00Z','2026-02-28T16:00:00Z']) {
    test(`demo cash, links and cycles at ${date}`, () => {
        const instant = new Date(date), userId = new mongoose.Types.ObjectId();
        const d = buildDemoData(userId, instant);
        assert.equal(d.transactions.length, 61);
        assert.equal(d.items.filter(i => i.usageStatus === 'ACTIVE').length, 20);
        const trips = d.transactions.filter(tx => tx.idempotencyKey.includes('shopping-trip:'));
        assert.equal(trips.length, 3);
        for (const tx of trips) {
            assert.ok(tx.items.length >= 5);
            assert.equal(tx.amount, tx.items.reduce((sum, line) => sum + line.totalPrice, 0));
        }
        const market = d.transactions.filter(tx => tx.category === 'MARKET');
        assert.equal(market.length,15);
        for (const tx of market) {
            assert.ok(tx.items.length >= 3);
            assert.equal(tx.amount,tx.items.reduce((sum,line)=>sum+line.totalPrice,0));
        }
        for (const name of ['Ức gà','Kim chi cải thảo']) {
            const batches = d.items.filter(item => item.usageStatus === 'ACTIVE' && item.itemName === name);
            assert.equal(batches.length,2);
            assert.ok(batches.some(item => item.expiryDate < instant));
            assert.ok(batches.some(item => item.expiryDate > instant));
        }
        assert.deepEqual(balanceFromTransactions(d.userFields, d.transactions), { cash: 2900000, savings: 700000 });
        let cash = d.userFields.finance.openingCash;
        for (const tx of [...d.transactions].sort((a,b) => a.date-b.date)) {
            cash += tx.cashDelta; assert.ok(cash >= 0);
            assert.ok(tx.date <= instant); assert.ok(tx.date >= d.userFields.finance.initializedAt);
            assert.ok(Number.isSafeInteger(tx.amount));
            assert.equal(new (require('../src/models/transaction.model'))(tx).validateSync(), undefined);
        }
        for (const item of d.items) {
            const tx = d.transactions.find(t => t._id.equals(item.transactionId));
            assert.ok(tx); assert.equal(tx.userId, userId);
            assert.equal(tx.items.find(line => line.itemName === item.itemName).itemName, item.itemName);
            assert.equal(new (require('../src/models/item.model'))(item).validateSync(), undefined);
        }
        for (const cycle of d.userFields.finance.fixedCycles) {
            const unpaid = fixedState(cycle.plans, d.transactions, cycle.key)[0].remaining;
            assert.equal(unpaid, cycle.key === cycleDates(20, instant).key ? 2000000 : 0);
        }
        const copy = buildDemoData(new mongoose.Types.ObjectId(), instant);
        const paidReadings = d.readings.filter(row => row.transactionId);
        assert.equal(paidReadings.length, 6);
        for (const row of paidReadings) {
            const payment = d.transactions.find(tx => tx._id.equals(row.transactionId));
            assert.ok(payment);
            assert.equal(payment.category, 'HOUSING');
            assert.equal(payment.amount, row.estimatedCost);
            assert.equal(row.paidAmount, payment.amount);
            assert.equal(row.differenceAmount, 0);
            assert.equal(row.userId, payment.userId);
        }
        assert.equal(d.readings.filter(row => !row.isFirstReading && !row.transactionId).length,2);
        assert.ok(!copy.transactions[0]._id.equals(d.transactions[0]._id));
        assert.ok(d.items.some(i => i.usageStatus === 'ACTIVE' && i.expiryDate < instant));
    });
}

test('existing guest skips setting, seed and session', async () => {
    const guest = { loginType: 'guest' };
    const result = await initializeGuest('uid', { User: { findOne: async () => guest },
        Setting: { findById: () => { throw new Error('should not read'); } } });
    assert.equal(result.user, guest); assert.equal(result.isNewGuest, false);
});
test('promoted Google identity cannot create another guest', async () => {
    await assert.rejects(initializeGuest('uid', { User: { findOne: async () => ({ loginType: 'google' }) } }), { statusCode: 409 });
});

for (const enabled of [false, true]) test(`new guest atomic initialization enabled=${enabled}`, async () => {
    const writes = []; const session = { withTransaction: async fn => fn(), endSession: async () => writes.push('ended') };
    const deps = {
        User: { findOne: async () => null, create: async (docs, options) => { assert.equal(options.session, session); writes.push('user'); return docs; } },
        Setting: { findById: () => ({ lean: async () => ({ enabled, version: 'guest-v1' }) }) },
        Transaction: { insertMany: async (docs, options) => { assert.equal(options.session, session); assert.equal(docs.length,61); writes.push('tx'); } },
        Item: { insertMany: async (docs, options) => { assert.equal(options.session,session); writes.push('items'); } },
        Meter: { insertMany: async (docs, options) => { assert.equal(options.session,session); assert.equal(docs.length,2); writes.push('meters'); } },
        MeterReading: { insertMany: async (docs, options) => { assert.equal(options.session,session); assert.equal(docs.length,10); writes.push('readings'); } },
        RpgLog: { insertMany: async (docs, options) => { assert.equal(options.session,session); assert.equal(docs.length,7); writes.push('logs'); } },
        Notification: { create: async (docs, options) => {
            assert.equal(options.session,session);
            // Mongoose rejects multiple create() documents in a session without ordered writes.
            if (docs.length > 1) assert.equal(options.ordered, true);
            writes.push(docs.length===1?'welcome':'notifications');
        } },
        connection: { startSession: async () => session }
    };
    const result = await initializeGuest('uid', deps);
    assert.equal(result.isNewGuest,true);
    assert.deepEqual(writes, enabled ? ['user','tx','items','meters','readings','logs','notifications','welcome','ended'] : ['user','welcome','ended']);
});

test('demo journal records snapshots and notifications without granting fake rewards',()=>{
 const id=new mongoose.Types.ObjectId(), instant=new Date('2026-10-08T08:00:00Z');
 const d=buildDemoData(id,instant),copy=buildDemoData(id,instant);
 assert.equal(d.logs.length,7);assert.equal(d.notifications.length,6);
 for(const log of d.logs){
  assert.doesNotMatch(log.title,/mẫu|demo/i);
  if(log.type==='TRANSACTION'){
   const tx=d.transactions.find(row=>row._id.equals(log.metadata.transactionId));
   assert.ok(tx);assert.equal(log.createdAt.getTime(),tx.date.getTime());
   assert.ok(log.metadata.demoSummary.includes(tx.amount.toLocaleString('vi-VN')));
  }
  assert.equal(log.metadata.demo,true);
  assert.equal(new (require('../src/models/rpgLog.model'))(log).validateSync(),undefined);
  assert.ok(['xpChange','hpChange','manaChange','defChange','wisChange'].every(key=>!log[key]));
 }
 for(const notice of d.notifications){
  assert.doesNotMatch(notice.title+' '+notice.message,/mẫu|demo/i);
  assert.equal(new(require('../src/models/notification.model'))(notice).validateSync(),undefined);
 }
 assert.ok(d.logs[0]._id.equals(copy.logs[0]._id));
 assert.ok(d.notifications[0]._id.equals(copy.notifications[0]._id));
 assert.equal(d.logs.filter(log=>log.metadata.statCode).length,4);
});

test('manual meter history preserves chain and October baseline without AI/payment data', () => {
    const { buildDemoMeters } = require('../src/services/guest-demo-data.service');
    const d = buildDemoMeters(new mongoose.Types.ObjectId(), new Date('2026-10-08T08:00:00Z'));
    for (const meter of d.meters) {
        assert.equal(new (require('../src/models/meter.model'))(meter).validateSync(), undefined);
        const chain = d.readings.filter(r => r.meterId.equals(meter._id));
        assert.equal(chain.length,5);
        assert.equal(chain[0].isFirstReading,true); assert.equal(chain[0].estimatedCost,0);
        assert.equal(chain[4].currentValue, meter.meterType === 'POWER' ? 2980 : 588);
        assert.equal(chain[4].readingDate.toISOString(),'2026-09-30T17:00:00.000Z');
        for (let i=0;i<chain.length;i++) {
            const row = chain[i];
            assert.equal(new (require('../src/models/meterReading.model'))(row).validateSync(), undefined);
            assert.equal(row.inputSource,'MANUAL'); assert.equal(row.aiSessionId,undefined);
            assert.equal(row.transactionId,undefined);
            if (i) {
                assert.ok(row.previousReadingId.equals(chain[i-1]._id));
                assert.equal(row.usage,row.currentValue-chain[i-1].currentValue);
                assert.equal(row.estimatedCost,Math.round(row.usage*meter.unitPrice));
            }
        }
    }
});
test('failed transaction propagates and ends session', async () => {
    let ended = false;
    await assert.rejects(initializeGuest('uid', {
        User: { findOne: async () => null, create: async () => { throw new Error('write failed'); } },
        Setting: { findById: () => ({ lean: async () => null }) },
        connection: { startSession: async () => ({ withTransaction: async fn => fn(), endSession: async () => { ended=true; } }) }
    }), /write failed/);
    assert.equal(ended,true);
});
test('concurrent duplicate UID returns committed winner without reseeding', async () => {
    let reads = 0;
    const winner = { loginType: 'guest', providerId: 'uid' };
    const result = await initializeGuest('uid', {
        User: { findOne: async () => ++reads === 1 ? null : winner,
            create: async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); } },
        Setting: { findById: () => ({ lean: async () => ({ enabled: true, version: 'guest-v1' }) }) },
        connection: { startSession: async () => ({ withTransaction: async fn => fn(), endSession: async () => {} }) }
    });
    assert.equal(result.user, winner); assert.equal(result.isNewGuest, false);
});
