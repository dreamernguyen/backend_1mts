const Item = require('../models/item.model');
const { usableInventory } = require('./recipe-matching.service');

function daysRemaining(item, now = new Date()) {
    if (!item.expiryDate || item.expirySource === 'NOT_APPLICABLE') return null;
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const expiry = new Date(item.expiryDate);
    expiry.setHours(0, 0, 0, 0);
    return Math.ceil((expiry - start) / 86400000);
}

function createUsableInventorySnapshot(items, now = new Date()) {
    return usableInventory(items, now);
}

exports.loadUsableInventorySnapshot = async (userId, now = new Date()) => {
    const items = await Item.find({
        userId,
        usageStatus: 'ACTIVE',
        quantity: { $gt: 0 },
        standardQuantity: { $gt: 0 }
    }).sort({ expiryDate: 1, createdAt: 1 }).lean();

    return createUsableInventorySnapshot(items, now);
};

// Dựng context AI từ chính snapshot đã qua hard gate quantity/expiry.
function generateInventoryReportFromSnapshot(items, now = new Date()) {
    const report = {
        isEmpty: items.length === 0,
        onlySpices: true, 
        cookedLeftovers: [], 
        criticalRaw: [],     
        goodRaw: [],         
        spices: []           
    };

    if (report.isEmpty) return report;

    items.forEach(item => {
        const isSpice = item.category === 'SPICE';
        if (!isSpice && !item.isCookedMeal) {
            report.onlySpices = false; 
        }

        const daysLeft = daysRemaining(item, now);

        if (item.isCookedMeal) {
            let label = `${item.itemName} (${item.quantity} bữa)`;
            if (daysLeft !== null) label += ` - Hỏng sau ${daysLeft} ngày`;
            report.cookedLeftovers.push(label);
        } else if (isSpice) {
            report.spices.push(item.itemName);
        } else {
            // Raw items
            let label = `${item.itemName} (${item.quantity} ${item.unit})`;
            if (daysLeft !== null && daysLeft <= 2) {
                report.criticalRaw.push(label);
            } else {
                report.goodRaw.push(label);
            }
        }
    });

    // Nếu chỉ có đồ chín và gia vị, thì đánh dấu onlySpices = false
    if (report.cookedLeftovers.length > 0) {
        report.onlySpices = false;
    }

    return report;
}

// Giữ API service cũ cho call site khác, nhưng vẫn dùng cùng quy tắc snapshot.
exports.generateInventoryReport = async (userId, now = new Date()) => {
    const snapshot = await exports.loadUsableInventorySnapshot(userId, now);
    return generateInventoryReportFromSnapshot(snapshot, now);
};

exports.createUsableInventorySnapshot = createUsableInventorySnapshot;
exports.generateInventoryReportFromSnapshot = generateInventoryReportFromSnapshot;
