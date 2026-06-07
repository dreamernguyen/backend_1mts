const Item = require('../models/item.model');

// Gom nhóm các vật phẩm trong tủ lạnh thành AI.
exports.generateInventoryReport = async (userId) => {
    const items = await Item.find({ userId: userId, usageStatus: 'ACTIVE' });

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

        const daysLeft = item.daysRemaining; // Sử dụng virtual field từ schema

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
};
