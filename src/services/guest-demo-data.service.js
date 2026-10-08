const mongoose = require('mongoose');
const moment = require('moment-timezone');
const { cycleDates, balanceFromTransactions } = require('./finance.service');
const VERSION = 'guest-v1';
const SETTING_ID = 'guest-dataset';

function historicalMarketLines(amount, expiryDate) {
    return [
        ['Gạo', 'DRY_FOOD', 'RICE_GRAIN', 2, 'kg', 2000, 'G', 60000],
        ['Trứng gà', 'EGG', '', 10, 'quả', 10, 'PIECE', 30000],
        ['Thịt heo', 'MEAT', 'PORK', 1000, 'g', 1000, 'G', amount - 90000]
    ].map(([name, category, subCategory, quantity, unit, standardQuantity, standardUnit, totalPrice]) => ({
        rawName: name, itemName: name, category, subCategory, quantity, originalQuantity: quantity,
        unit, standardQuantity, standardUnit, purchasePrice: totalPrice / quantity,
        baseUnitPrice: totalPrice / standardQuantity, totalPrice,
        storageLocation: category === 'DRY_FOOD' ? 'PANTRY' : 'FRIDGE', expirySource: 'USER', expiryDate
    }));
}

function buildDemoMeters(userId, instant = new Date()) {
    const month = moment(instant).tz('Asia/Ho_Chi_Minh').startOf('month');
    const { calculateReading } = require('./meter.service');
    const meters = [], readings = [];
    for (const [meterType, unit, unitPrice, values] of [
        ['POWER', 'KWH', 3500, [2620, 2698, 2804, 2892, 2980]],
        ['WATER', 'M3', 15000, [556, 563, 573, 579, 588]]
    ]) {
        const meterId = new mongoose.Types.ObjectId();
        meters.push({ _id: meterId, userId, meterType, unit, unitPrice,
            name: meterType === 'POWER' ? 'Công tơ điện phòng trọ' : 'Công tơ nước phòng trọ' });
        let previousReadingId = null;
        for (let i = 0; i < values.length; i++) {
            const id = new mongoose.Types.ObjectId();
            readings.push({ _id: id, userId, meterId, meterType, unit, unitPrice,
                readingDate: month.clone().subtract(4 - i, 'months').toDate(), previousReadingId,
                ...calculateReading({ previousValue: i ? values[i - 1] : null, currentValue: values[i], unitPrice }),
                inputSource: 'MANUAL', ocrEngine: 'MANUAL',
                idempotencyKey: `demo:${VERSION}:${meterType}:${i}` });
            previousReadingId = id;
        }
    }
    return { meters, readings };
}

// Synthetic demo history only. No OCR/AI telemetry or earned rewards are seeded.
function buildDemoData(userId, instant = new Date()) {
    const now = moment(instant).tz('Asia/Ho_Chi_Minh');
    const current = cycleDates(20, instant);
    const transactions = [], items = [], cycles = [];
    const plans = [{ code: 'RENT', amount: 2000000 }];
    function add(date, amount, category, note, extra = {}) {
        const tx = { _id: new mongoose.Types.ObjectId(), userId, date: date.toDate(), amount,
            category, note, transactionType: 'EXPENSE', financeKind: 'NORMAL', balanceTracked: true,
            cashDelta: -amount, savingsDelta: 0, paymentMethod: 'CASH',
            idempotencyKey: `demo:${VERSION}:${transactions.length}`, items: [], ...extra };
        transactions.push(tx); return tx;
    }
    for (let offset = -3; offset <= 0; offset++) {
        const start = moment(current.startDate).tz('Asia/Ho_Chi_Minh').add(offset, 'months');
        const end = start.clone().add(1, 'month');
        const key = start.format('YYYY-MM-DD');
        cycles.push({ key, startDate: start.toDate(), endExclusive: end.toDate(), plans });
        const dated = day => moment.min(start.clone().add(day, 'days').add(8, 'hours'), now.clone());
        add(dated(0), 5000000, 'SALARY', 'Thu nhập làm thêm và hỗ trợ sinh hoạt',
            { transactionType: 'INCOME', cashDelta: 5000000, paymentMethod: 'BANK_TRANSFER' });
        if (offset === 0) continue;
        add(dated(1), 2000000, 'HOUSING', 'Thanh toán tiền trọ',
            { fixedPayment: { code: 'RENT', cycleKey: key, closes: true } });
        const expenses = [
            ['MARKET', 240000], ['RESTAURANT', 85000], ['TRANSPORT', 120000],
            ['MARKET', 310000], ['ACADEMICS', 180000], ['RESTAURANT', 95000],
            ['ENTERTAINMENT', 150000], ['MARKET', 280000], ['TRANSPORT', 130000],
            ['CLOTHING', 350000], ['RESTAURANT', 90000], ['MARKET', 290000],
            ['HEALTHCARE', 100000], ['ACADEMICS', 200000]
        ]; // 3 triệu chi khác + 2 triệu tiền trọ = thu nhập mỗi kỳ.
        expenses[expenses.length - 1][1] += 3000000 - expenses.reduce((sum, row) => sum + row[1], 0);
        for (let i = 0; i < expenses.length; i++) {
            const [category, amount] = expenses[i];
            const tx = add(dated(i + 2), amount, category, {
                MARKET: 'Đi chợ mua thực phẩm', RESTAURANT: 'Ăn ngoài', TRANSPORT: 'Xăng xe',
                ACADEMICS: 'Sách và học phí', ENTERTAINMENT: 'Cà phê cùng bạn',
                CLOTHING: 'Mua quần áo', HEALTHCARE: 'Chi phí chăm sóc sức khỏe'
            }[category]);
            if (category === 'MARKET') {
                const lines = historicalMarketLines(amount, end.clone().add(60, 'days').toDate());
                tx.items.push(...lines);
                for (const stock of lines) items.push({ ...stock, _id: new mongoose.Types.ObjectId(), userId, transactionId: tx._id,
                    quantity: 0, standardQuantity: 0, usageStatus: 'CONSUMED' });
            }
        }
    }
    // Each tuple: ingredient, category, subcategory, quantity in G/PIECE, total cost, expiry days.
    const stocks = [
        ['Trứng gà','EGG','',12,36000,10], ['Hành lá','VEGETABLE','HERB_SPICE_VEG',100,8000,2],
        ['Cà chua','VEGETABLE','ROOT_VEG',1000,25000,3], ['Cải bẹ xanh','VEGETABLE','LEAFY_VEG',600,18000,2],
        ['Thịt heo băm','MEAT','PORK',600,78000,3], ['Nấm bào ngư','VEGETABLE','MUSHROOM',500,35000,1],
        ['Ức gà','MEAT','CHICKEN',500,45000,1], ['Kim chi cải thảo','VEGETABLE','LEAFY_VEG',400,32000,-1],
        ['Gạo','DRY_FOOD','RICE_GRAIN',3000,60000,90], ['Nước mắm','SPICE','SAUCE',250,25000,120],
        ['Dầu ăn','SPICE','BASIC_SPICE',500,30000,120], ['Muối','SPICE','BASIC_SPICE',200,5000,180],
        ['Đường','SPICE','BASIC_SPICE',300,10000,180], ['Tỏi','VEGETABLE','HERB_SPICE_VEG',200,15000,30],
        ['Hành tím','VEGETABLE','HERB_SPICE_VEG',200,12000,30], ['Cá basa','SEAFOOD','FISH',800,64000,5],
        ['Chuối','FRUIT','TROPICAL',1000,20000,2], ['Sữa tươi','DRINK','MILK',1000,35000,7]
    ];
    for (const [name, category, subCategory, quantity, cost, days] of stocks) {
        const liquid = ['Nước mắm','Dầu ăn','Sữa tươi'].includes(name);
        const stock = { rawName: name, itemName: name, category, subCategory, quantity, originalQuantity: quantity,
            unit: category === 'EGG' ? 'quả' : liquid ? 'ml' : 'g', standardQuantity: quantity,
            standardUnit: category === 'EGG' ? 'PIECE' : liquid ? 'ML' : 'G', purchasePrice: cost / quantity,
            baseUnitPrice: cost / quantity, storageLocation: ['DRY_FOOD','SPICE'].includes(category) ? 'PANTRY' : 'FRIDGE',
            expirySource: 'USER', expiryDate: now.clone().startOf('day').add(days, 'days').toDate() };
        const purchase = moment.max(moment(current.startDate), now.clone().subtract(2, 'days'));
        const tx = add(purchase, cost, 'MARKET', `Mua ${name}`, { merchantName: 'Chợ gần nhà',
            items: [{ ...stock, totalPrice: cost }] });
        items.push({ ...stock, _id: new mongoose.Types.ObjectId(), userId, transactionId: tx._id, usageStatus: 'ACTIVE' });
    }
    // Different expiry dates stay as separate batches under one ingredient.
    for (const name of ['Ức gà', 'Kim chi cải thảo']) {
        const fresh = items.find(item => item.usageStatus === 'ACTIVE' && item.itemName === name);
        const oldQuantity = fresh.quantity * 0.25;
        const old = { ...fresh, _id: new mongoose.Types.ObjectId(), quantity: oldQuantity,
            originalQuantity: oldQuantity, standardQuantity: oldQuantity,
            expiryDate: now.clone().startOf('day').subtract(1, 'day').toDate() };
        fresh.quantity -= oldQuantity;
        fresh.originalQuantity = fresh.quantity;
        fresh.standardQuantity = fresh.quantity;
        fresh.expiryDate = now.clone().startOf('day').add(5, 'days').toDate();
        items.push(old);
    }
    const active = items.filter(item => item.usageStatus === 'ACTIVE');
    const singlePurchaseIds = new Set(active.map(item => String(item.transactionId)));
    for (let i = transactions.length - 1; i >= 0; i--) {
        if (singlePurchaseIds.has(String(transactions[i]._id))) transactions.splice(i, 1);
    }
    for (let trip = 0; trip < 3; trip++) {
        const lines = active.filter((item, i) => i % 3 === trip);
        const date = moment.max(moment(current.startDate), now.clone().subtract(2 + trip * 2, 'days'));
        const total = lines.reduce((sum, item) => sum + item.quantity * item.purchasePrice, 0);
        const tx = add(date, Math.round(total), 'MARKET', ['Đi chợ mua thịt, rau và gia vị',
            'Bổ sung thực phẩm cho bữa ăn tại nhà', 'Mua đồ khô và thực phẩm phòng trọ'][trip],
            { merchantName: trip === 1 ? 'Siêu thị gần nhà' : 'Chợ gần nhà',
                idempotencyKey: `demo:${VERSION}:shopping-trip:${trip}` });
        for (const item of lines) {
            item.transactionId = tx._id;
            tx.items.push({ rawName: item.rawName, itemName: item.itemName, category: item.category,
                subCategory: item.subCategory, quantity: item.quantity, unit: item.unit,
                standardQuantity: item.standardQuantity, standardUnit: item.standardUnit,
                purchasePrice: item.purchasePrice, totalPrice: item.quantity * item.purchasePrice,
                storageLocation: item.storageLocation, expiryDate: item.expiryDate, expirySource: item.expirySource });
        }
    }
    const stockCost = stocks.reduce((sum, row) => sum + row[4], 0);
    for (const [category, amount, note] of [
        ['TRANSPORT', 180000, 'Xăng xe trong kỳ'],
        ['ACADEMICS', 600000, 'Học phí khóa học'],
        ['OTHERS', 2400000 - stockCost - 780000, 'Sinh hoạt và mua đồ dùng trong kỳ']
    ]) add(now.clone(), amount, category, note);
    const meterData = buildDemoMeters(userId, instant);
    // Prior calendar months are paid. Reallocate synthetic spending instead of
    // changing the cash balance or inventing additional income.
    for (const reading of meterData.readings) {
        if (reading.isFirstReading || reading.readingDate >= now.clone().startOf('month').toDate()) continue;
        const paymentDate = moment(reading.readingDate).tz('Asia/Ho_Chi_Minh').add(1, 'day').add(8, 'hours');
        const cycleKey = cycleDates(20, paymentDate.toDate()).key;
        // The first payment is before the old synthetic history starts. Extend
        // tracking to include it and keep its cash backed by the opening balance.
        const payment = add(paymentDate, reading.estimatedCost, 'HOUSING',
            `Thanh toán tiền ${reading.meterType === 'POWER' ? 'điện' : 'nước'} tháng ${paymentDate.format('MM/YYYY')}`,
            { paymentMethod: 'BANK_TRANSFER' });
        reading.transactionId = payment._id;
        reading.paidAmount = reading.estimatedCost;
        reading.paidAt = paymentDate.toDate();
        reading.transactionDate = paymentDate.toDate();
        reading.differenceAmount = 0;
        reading.differencePercent = 0;
        reading.hasLargeDifference = false;
        reading.paymentIdempotencyKey = `demo:${VERSION}:paid:${reading.meterType}:${paymentDate.format('YYYY-MM')}`;
        const reallocated = transactions.find(tx => tx.category === 'ACADEMICS'
            && cycleDates(20, tx.date).key === cycleKey && tx.amount >= reading.estimatedCost);
        if (reallocated) {
            reallocated.amount -= reading.estimatedCost;
            reallocated.cashDelta = -reallocated.amount;
        }
    }
    const net = transactions.reduce((sum, tx) => sum + tx.cashDelta, 0);
    // Opening balance reconciles all history; current salary remains cash until rent is paid.
    const openingCash = Math.max(0, 2900000 - net);
    const userFields = { monthlyBudget: 5000000, essentialBudget: 3000000, fixedBudget: 2000000,
        savingsFund: 700000, cycleStartDay: 20,
        finance: { initializedAt: new Date(Math.min(cycles[0].startDate.getTime(), ...transactions.map(tx => tx.date.getTime()))), openingCash, openingSavings: 700000,
            revision: 0, fixedPlans: plans, fixedCycles: cycles },
        demoData: { version: VERSION, seededAt: instant } };
    const balance = balanceFromTransactions(userFields, transactions);
    if (balance.cash !== 2900000) throw new Error('Demo opening balance cannot reconcile');
    const data = { userFields, transactions, items, ...meterData };
    return { ...data, ...require('./demo-journal.service').buildDemoJournal(userId, data, instant) };
}

async function initializeGuest(providerId, dependencies = {}) {
    const User = dependencies.User || require('../models/user.model');
    const Setting = dependencies.Setting || require('../models/demoSetting.model');
    const Transaction = dependencies.Transaction || require('../models/transaction.model');
    const Item = dependencies.Item || require('../models/item.model');
    const Notification = dependencies.Notification || require('../models/notification.model');
    const Meter = dependencies.Meter || require('../models/meter.model');
    const MeterReading = dependencies.MeterReading || require('../models/meterReading.model');
    const RpgLog = dependencies.RpgLog || require('../models/rpgLog.model');
    const connection = dependencies.connection || mongoose;
    const existing = await User.findOne({ providerId });
    if (existing) {
        if (existing.loginType !== 'guest') throw Object.assign(new Error('Tài khoản đã liên kết Google, hãy đăng nhập Google.'), { statusCode: 409 });
        return { user: existing, isNewGuest: false };
    }
    const setting = await Setting.findById(SETTING_ID).lean();
    if (setting?.enabled && setting.version !== VERSION) throw new Error('Unsupported guest demo dataset version');
    const session = await connection.startSession();
    try {
        let user;
        await session.withTransaction(async () => {
            const id = new mongoose.Types.ObjectId();
            const demo = setting?.enabled ? buildDemoData(id) : null;
            [user] = await User.create([{ _id: id, displayName: 'Cư dân 1MTS', loginType: 'guest', providerId,
                ...(demo?.userFields || {}) }], { session });
            if (demo) {
                await Transaction.insertMany(demo.transactions, { session });
                await Item.insertMany(demo.items, { session });
                await Meter.insertMany(demo.meters, { session });
                await MeterReading.insertMany(demo.readings, { session });
                await RpgLog.insertMany(demo.logs, { session });
                await Notification.create(demo.notifications, { session, ordered: true });
            }
            await Notification.create([{ userId: id, title: 'Chào mừng thành viên mới! 🎉',
                message: demo ? 'Tài khoản đã có dữ liệu mẫu để trải nghiệm. Đây là dữ liệu demo, không phải tài chính thực tế.'
                    : 'Chào mừng cư dân đến với hành trình sinh tồn - 1MTS', type: 'SYSTEM' }], { session });
        });
        return { user, isNewGuest: true };
    } catch (error) {
        // Concurrent login may have committed the same Firebase identity first.
        if (error.code === 11000) {
            const winner = await User.findOne({ providerId, loginType: 'guest' });
            if (winner) return { user: winner, isNewGuest: false };
        }
        throw error;
    } finally { await session.endSession(); }
}
module.exports = { VERSION, SETTING_ID, buildDemoData, buildDemoMeters, historicalMarketLines, initializeGuest };
