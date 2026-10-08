const test = require('node:test');
const assert = require('node:assert/strict');
const { wasteValue } = require('../src/services/waste-value.service');
const { inventoryValue } = require('../src/services/rpg.service');
test('gram-priced chicken: full and partial waste use unit price without dividing again', () => {
    const batch = { category:'MEAT', purchasePrice:90, quantity:375, originalQuantity:500 };
    assert.equal(wasteValue(batch,375),33750);
    assert.equal(wasteValue(batch,125),11250);
    const ledger = {...batch,usageStatus:'WASTED',purchasePrice:wasteValue(batch,375)};
    assert.equal(inventoryValue(ledger,new Date(),true),33750);
});
test('piece and package prices keep native unit basis; fractional quantities are supported', () => {
    assert.equal(wasteValue({purchasePrice:3000,originalQuantity:12},2),6000);
    assert.equal(wasteValue({purchasePrice:25000},0.5),12500);
    assert.equal(wasteValue({purchasePrice:null},100),0);
    assert.equal(wasteValue({purchasePrice:90},0),0);
});
