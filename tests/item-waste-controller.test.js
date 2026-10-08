const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const Item = require('../src/models/item.model');
const User = require('../src/models/user.model');
const Notification = require('../src/models/notification.model');
const Log = require('../src/models/rpgLog.model');
const rpg = require('../src/services/rpg.service');
const { batchUpdate } = require('../src/controllers/item.controller');

for (const full of [false,true]) test(`waste controller reconciles notification and ledger, full=${full}`, async t => {
    const userId = new mongoose.Types.ObjectId();
    const batches = [0,1].map(i => new Item({ userId, itemName:'Ức gà', rawName:'Ức gà',
        category:'MEAT',subCategory:'CHICKEN',quantity:500,originalQuantity:500,
        standardQuantity:500,standardUnit:'G',unit:'g',purchasePrice:90,
        expiryDate:new Date(`2026-10-0${i+1}`),usageStatus:'ACTIVE' }));
    const query = rows => ({session(){return this;},sort(){return this;},then(resolve,reject){return Promise.resolve(rows).then(resolve,reject);}});
    const session = {startTransaction(){},commitTransaction:async()=>{},abortTransaction:async()=>{},endSession(){}};
    t.mock.method(mongoose,'startSession',async()=>session);
    t.mock.method(Item,'find',filter=>query(filter._id ? batches.filter(b=>filter._id.$in.map(String).includes(String(b._id))) : batches));
    let operations=[],ledger=[],notice,log;
    t.mock.method(Item,'bulkWrite',async ops=>{operations=ops;});
    t.mock.method(Item,'create',async (docs,options)=>{
        assert.equal(options.session,session);assert.equal(options.ordered,true);ledger=docs;return docs;
    });
    t.mock.method(Notification,'create',async docs=>{notice=docs[0];return docs;});
    t.mock.method(Log,'create',async docs=>{log=docs[0];return [{...log,_id:new mongoose.Types.ObjectId()}];});
    t.mock.method(Log,'findByIdAndUpdate',async()=>{});
    const user={essentialBudget:3000000,rpgStats:{wis:50},save:async()=>{}};
    t.mock.method(User,'findById',async()=>user);
    t.mock.method(rpg,'calculateUserStats',async()=>{user.rpgStats.wis=48;return user;});
    let response;
    const qty=full?500:125;
    await batchUpdate({params:{userId:String(userId)},body:{groupMetadata:{targetItemName:'Ức gà'},
        consumptions:batches.map(b=>({batchIds:[String(b._id)],consumeQuantity:qty,consumeStandardQuantity:qty,isWasted:true}))}},
        {status(code){assert.equal(code,200);return this;},json(body){response=body;}},error=>{throw error;});
    const total=qty*90*2;
    assert.equal(response.success,true);
    assert.equal(log.metadata.financialWaste,total);
    assert.ok(notice.message.includes(total.toLocaleString('vi-VN')));
    if(full){
        assert.equal(ledger.length,0);
        assert.equal(operations.filter(o=>o.updateOne?.update.$set?.usageStatus==='WASTED').reduce((sum,o)=>sum+o.updateOne.update.$set.purchasePrice,0),total);
    }else{
        assert.equal(ledger.length,2);
        assert.equal(ledger.reduce((sum,row)=>sum+rpg.inventoryValue(row,new Date(),true),0),total);
        assert.ok(operations.every(o=>o.updateOne.update.$set.quantity===375));
    }
});
