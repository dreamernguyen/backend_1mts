// Prices are immutable purchase facts, never divided by remaining inventory.
const keyFor = item => [item.itemName, item.category, item.subCategory || 'OTHER', item.standardUnit].join('|');
function purchaseFact(item) {
    const quantity = Number(item.originalQuantity ?? item.quantity);
    const measure = Number(item.standardQuantity);
    const total = Number(item.totalPrice ?? (quantity * Number(item.purchasePrice)));
    if (!item.itemName || !['G', 'ML', 'PIECE'].includes(item.standardUnit)
        || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(measure) || measure <= 0
        || !Number.isFinite(total) || total <= 0 || item.measurementStatus === 'REVIEW_REQUIRED'
        || item.requiresDeliveryConfirmation && item.deliveryConfirmed !== true
        || (item.warnings || []).some(w => ['TOTAL_MISMATCH', 'AMBIGUOUS_UNIT', 'MISSING_QUANTITY', 'INVALID_QUANTITY', 'AMBIGUOUS_PACKAGE_MEASURE'].includes(w.code))) return null;
    return { key: keyFor(item), name: item.itemName, unit: item.standardUnit, measure, total, price: total / measure };
}
function comparePurchases(currentItems, history) {
    const references = new Map();
    for (const transaction of history) {
        // Aggregate duplicate lines inside the same historic purchase too.
        const groups = aggregate(transaction.items || []);
        for (const [key, fact] of groups) if (!references.has(key)) references.set(key, { ...fact, transactionId: String(transaction._id), date: transaction.date });
    }
    const details = [];
    for (const [key, fact] of aggregate(currentItems)) {
        const previous = references.get(key);
        if (!previous) continue;
        const saved = (previous.price - fact.price) * fact.measure;
        // Ignore sub-dong differences from decimal arithmetic.
        if (saved < 1) continue;
        details.push({ itemName: fact.name, standardUnit: fact.unit, previousPrice: previous.price,
            currentPrice: fact.price, purchasedMeasure: fact.measure, savedAmount: saved,
            referenceTransactionId: previous.transactionId, referenceDate: previous.date });
    }
    return { details, savedAmount: Math.round(details.reduce((sum, d) => sum + d.savedAmount, 0)), wisBonus: details.length };
}
function aggregate(items) {
    const groups = new Map();
    const invalidKeys = new Set();
    for (const item of items) {
        const fact = purchaseFact(item);
        if (!fact) { invalidKeys.add(keyFor(item)); continue; }
        const previous = groups.get(fact.key);
        if (previous) { previous.total += fact.total; previous.measure += fact.measure; previous.price = previous.total / previous.measure; }
        else groups.set(fact.key, { ...fact });
    }
    for (const key of invalidKeys) groups.delete(key);
    return groups;
}
module.exports = { purchaseFact, comparePurchases };
