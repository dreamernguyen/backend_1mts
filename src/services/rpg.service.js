const User = require('../models/user.model');
const Transaction = require('../models/transaction.model');
const Item = require('../models/item.model');

const moment = require('moment-timezone');

const RPG_FORMULA_VERSION = 'rpg_v3';
const WIS_BASELINE = 50;
const FALLBACK_WASTE_PENALTY = 10;
const FIXED_EXPENSE_CATEGORIES = new Set(['HOUSING', 'UTILITIES', 'LOAN', 'ACADEMICS']);
const ESSENTIAL_EXPENSE_CATEGORIES = new Set(['FOOD', 'GROCERIES', 'TRANSPORT', 'HEALTHCARE']);

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const toAmount = value => Math.max(0, Number(value) || 0);

// Hàm tính ngày bắt đầu và kết thúc chu kỳ dựa vào cycleStartDay
exports.getCycleDates = (cycleStartDay) => {
    // Luôn lấy thời gian hiện tại theo múi giờ Việt Nam
    const nowMoment = moment().tz('Asia/Ho_Chi_Minh');
    const now = nowMoment.toDate(); // Giữ lại object Date cho việc tương thích nếu có
    const currentYear = nowMoment.year();
    const currentMonth = nowMoment.month(); // 0-indexed
    const currentDate = nowMoment.date();

    let startMoment, endMoment;

    if (currentDate >= cycleStartDay) {
        // Chu kỳ của tháng này
        startMoment = moment.tz([currentYear, currentMonth, cycleStartDay], 'Asia/Ho_Chi_Minh');
        endMoment = moment.tz([currentYear, currentMonth + 1, cycleStartDay], 'Asia/Ho_Chi_Minh').subtract(1, 'milliseconds');
    } else {
        // Chu kỳ của tháng trước
        startMoment = moment.tz([currentYear, currentMonth - 1, cycleStartDay], 'Asia/Ho_Chi_Minh');
        endMoment = moment.tz([currentYear, currentMonth, cycleStartDay], 'Asia/Ho_Chi_Minh').subtract(1, 'milliseconds');
    }

    return { 
        startDate: startMoment.toDate(), 
        endDate: endMoment.toDate(), 
        now 
    };
};

exports.calculateRpgState = ({
    monthlyBudget = 0,
    fixedBudget = 0,
    essentialBudget = 0,
    savingsFund = 0,
    totalExpense = 0,
    fixedExpense = 0,
    essentialExpense = 0,
    daysRemaining = 0,
    totalCycleDays = 0,
    inventoryValue = 0,
    wastedValue = 0,
    bonusWis = 0,
    calculatedAt = new Date()
} = {}) => {
    const safeMonthlyBudget = toAmount(monthlyBudget);
    const safeFixedBudget = toAmount(fixedBudget);
    const safeEssentialBudget = toAmount(essentialBudget);
    const safeSavingsFund = toAmount(savingsFund);
    const safeTotalExpense = toAmount(totalExpense);
    const safeFixedExpense = toAmount(fixedExpense);
    const safeEssentialExpense = toAmount(essentialExpense);
    const safeInventoryValue = toAmount(inventoryValue);
    const safeWastedValue = toAmount(wastedValue);
    const safeBonusWis = toAmount(bonusWis);
    
    const hasCycleDays = Number(totalCycleDays) > 0;
    const safeDaysRemaining = Math.max(1, Number(daysRemaining) || 1);
    const safeTotalCycleDays = Math.max(1, Number(totalCycleDays) || 1);
    const budgetConfigured = safeMonthlyBudget > 0 && safeEssentialBudget > 0;
    const coverageSignals = [safeMonthlyBudget > 0, safeEssentialBudget > 0, hasCycleDays];
    const dataCoverage = Math.round((coverageSignals.filter(Boolean).length / coverageSignals.length) * 100) / 100;

    // Tính toán Tiền mặt tự do (Free Cash)
    const unpaidFixed = Math.max(0, safeFixedBudget - safeFixedExpense);
    const totalRemainingCash = Math.max(0, safeMonthlyBudget - safeTotalExpense);
    const freeCash = Math.max(0, totalRemainingCash - unpaidFixed);

    // Tính toán HP (Máu)
    const dailyEssentialNeed = safeEssentialBudget / safeTotalCycleDays;
    const requiredSurvivalFunds = dailyEssentialNeed * safeDaysRemaining;
    const availableSurvivalAssets = freeCash + safeInventoryValue;
    
    const hp = budgetConfigured
        ? Math.round(clamp(100 * availableSurvivalAssets / Math.max(requiredSurvivalFunds, 1)))
        : WIS_BASELINE;

    // Tính toán MANA (Quỹ linh hoạt)
    const requiredHoldCash = Math.max(0, requiredSurvivalFunds - safeInventoryValue);
    const mana = Math.max(0, freeCash - requiredHoldCash);

    // Tính toán DEF (Phòng thủ)
    const def = safeEssentialBudget > 0
        ? Math.round(clamp(100 * safeSavingsFund / safeEssentialBudget))
        : 0;

    // Tính toán WIS (Trí tuệ)
    const wastePenalty = safeEssentialBudget > 0
        ? Math.min(50, 100 * safeWastedValue / safeEssentialBudget)
        : safeWastedValue > 0 ? FALLBACK_WASTE_PENALTY : 0;
    const wis = Math.round(clamp(WIS_BASELINE + safeBonusWis - wastePenalty));

    const factors = entries => entries.map(([code, value]) => ({ code, value: Math.round(value * 100) / 100 }));
    
    return {
        hp, mana, def, wis, maxHp: 100, formulaVersion: RPG_FORMULA_VERSION, dataCoverage,
        statBreakdown: {
            formulaVersion: RPG_FORMULA_VERSION,
            calculatedAt: new Date(calculatedAt).toISOString(),
            dataCoverage,
            hp: factors([
                ['TOTAL_REMAINING_CASH', totalRemainingCash],
                ['UNPAID_FIXED_COSTS', unpaidFixed],
                ['FREE_CASH', freeCash],
                ['USABLE_INVENTORY_VALUE', safeInventoryValue],
                ['REQUIRED_SURVIVAL_FUNDS', requiredSurvivalFunds],
                ['DAILY_ESSENTIAL_NEED', dailyEssentialNeed],
                ['DAYS_REMAINING', safeDaysRemaining]
            ]),
            mana: factors([
                ['FREE_CASH', freeCash],
                ['REQUIRED_HOLD_CASH', requiredHoldCash],
                ['MANA_VND', mana]
            ]),
            def: factors([['SAVINGS_FUND', safeSavingsFund], ['ESSENTIAL_BUDGET', safeEssentialBudget]]),
            wis: factors([['BASELINE', WIS_BASELINE], ['BONUS_WIS', safeBonusWis], ['WASTE_PENALTY', wastePenalty], ['WASTED_VALUE', safeWastedValue]]),
            status: {
                hp: budgetConfigured ? 'OK' : 'UNCONFIGURED_BUDGET',
                mana: budgetConfigured ? 'OK' : 'UNCONFIGURED_FLEXIBLE_BUDGET',
                def: safeEssentialBudget > 0 ? 'OK' : 'UNCONFIGURED_ESSENTIAL_BUDGET',
                wis: dataCoverage > 0 ? 'OK' : 'INSUFFICIENT_DATA'
            }
        }
    };
};

exports.calculateUserStats = async (userId) => {
    try {
        const user = await User.findById(userId);
        if (!user) return null;

        const monthlyBudget = user.monthlyBudget || 0;
        const fixedBudget = user.fixedBudget || 0;
        const essentialBudget = user.essentialBudget || 0;
        const savingsFund = user.savingsFund || 0;
        const cycleStartDay = user.cycleStartDay || 1;

        // Dùng cùng chu kỳ tài chính để chỉ số phản ánh dữ liệu hiện tại.
        const { startDate, endDate, now } = exports.getCycleDates(cycleStartDay);
        
        const totalCycleDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
        const daysPassed = Math.ceil((now - startDate) / (1000 * 60 * 60 * 24));
        const daysRemaining = totalCycleDays - daysPassed;

        const transactions = await Transaction.find({
            userId,
            date: { $gte: startDate, $lte: endDate },
            transactionType: 'EXPENSE'
        });

        let totalExpense = 0;
        let fixedExpense = 0;
        let essentialExpense = 0;
        transactions.forEach(t => {
            totalExpense += t.amount;
            if (FIXED_EXPENSE_CATEGORIES.has(t.category)) fixedExpense += t.amount;
            if (ESSENTIAL_EXPENSE_CATEGORIES.has(t.category)) essentialExpense += t.amount;
        });

        // Các món còn dùng được
        const activeItems = await Item.find({
            userId,
            usageStatus: 'ACTIVE'
        });

        let inventoryValue = 0;
        activeItems.forEach(item => {
            // Loại bỏ các món đã quá hạn (daysRemaining < 0)
            const expiry = item.expiryDate ? new Date(item.expiryDate) : null;
            let isExpired = false;
            if (expiry) {
                expiry.setHours(0, 0, 0, 0);
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                if (expiry.getTime() < today.getTime()) {
                    isExpired = true;
                }
            }

            if (!isExpired && item.originalQuantity > 0) {
                const ratio = item.quantity / item.originalQuantity;
                inventoryValue += (item.purchasePrice * ratio);
            }
        });

        // Lấy các món bị vứt bỏ (Wasted) trong chu kỳ này để trừ điểm WIS
        const wastedItems = await Item.find({
            userId,
            usageStatus: 'WASTED',
            updatedAt: { $gte: startDate, $lte: endDate }
        });

        let wastedValue = 0;
        wastedItems.forEach(item => {
            if (item.originalQuantity > 0) {
                const ratio = item.quantity / item.originalQuantity;
                wastedValue += (item.purchasePrice * ratio);
            }
        });

        const state = exports.calculateRpgState({
            monthlyBudget, fixedBudget, essentialBudget, savingsFund, totalExpense, fixedExpense, essentialExpense,
            daysRemaining, totalCycleDays, inventoryValue, wastedValue,
            bonusWis: user.rpgStats?.bonusWis || 0, calculatedAt: now
        });

        // User cũ có thể chưa có subdocument này; gán lazily để không cần migration.
        user.rpgStats ||= {};
        // Chỉ ghi các field tương thích ngược vào subdocument hiện có.
        Object.assign(user.rpgStats, state);

        await user.save();

        return user.rpgStats;

    } catch (error) {
        console.error('[RPG Service] Lỗi khi tính toán chỉ số Gamification:', error);
        return null;
    }
};

exports.RPG_FORMULA_VERSION = RPG_FORMULA_VERSION;
exports.WIS_BASELINE = WIS_BASELINE;
exports.FALLBACK_WASTE_PENALTY = FALLBACK_WASTE_PENALTY;
