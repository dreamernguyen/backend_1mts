// ACTIVE inventory stores purchasePrice per native quantity unit.
function wasteValue(batch, deductedQuantity) {
    const price = Number(batch.purchasePrice);
    const quantity = Number(deductedQuantity);
    return Number.isFinite(price) && Number.isFinite(quantity)
        ? Math.max(0, price) * Math.max(0, quantity) : 0;
}
module.exports = { wasteValue };
