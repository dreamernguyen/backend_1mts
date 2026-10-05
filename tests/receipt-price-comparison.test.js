const test = require('node:test');
const assert = require('node:assert/strict');
const { comparePurchases } = require('../src/services/receipt-price-comparison.service');
const egg = (total, measure=10) => ({ itemName:'Trứng gà', category:'EGG', subCategory:'OTHER', quantity:1, unit:'Hộp', standardQuantity:measure, standardUnit:'PIECE', purchasePrice:total, totalPrice:total });
test('price reward uses immutable original purchase and aggregates duplicate lines', () => {
    const result = comparePurchases([egg(11000,5), egg(11000,5)], [{ _id:'previous', date:new Date(), items:[egg(25000)] }]);
    assert.equal(result.wisBonus,1); assert.equal(result.savedAmount,3000);
    assert.equal(result.details[0].currentPrice,2200);
});
test('ambiguous quantities, zero gifts and mismatched prices do not grant rewards', () => {
    const history=[{_id:'old',items:[egg(25000)]}];
    assert.equal(comparePurchases([{...egg(22000),measurementStatus:'REVIEW_REQUIRED'}],history).wisBonus,0);
    assert.equal(comparePurchases([egg(0)],history).wisBonus,0);
    assert.equal(comparePurchases([{...egg(22000),warnings:[{code:'TOTAL_MISMATCH'}]}],history).wisBonus,0);
});
test('price retains fractions before scaling and reference uses first eligible history purchase', () => {
    const meat = total => ({itemName:'Thịt đùi heo',category:'MEAT',subCategory:'PORK',quantity:1,standardQuantity:394,standardUnit:'G',purchasePrice:total,totalPrice:total});
    const result=comparePurchases([meat(25531)],[{_id:'latest',items:[meat(26000)]},{_id:'older',items:[meat(30000)]}]);
    assert.equal(result.savedAmount,469);
    assert.equal(result.details[0].currentPrice,25531/394);
});
