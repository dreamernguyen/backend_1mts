const User = require('../models/user.model');
const Item = require('../models/item.model');

const moment = require('moment-timezone');
const finance = require('./finance.service');

const RPG_FORMULA_VERSION = 'rpg_v4';
const WIS_BASELINE = 50;
const FALLBACK_WASTE_PENALTY = 10;

const clamp = (value, min = 0, max = 100) => Math.min(max, Math.max(min, value));
const toAmount = value => Math.max(0, Number(value) || 0);

exports.getCycleDates = finance.cycleDates;

exports.calculateRpgState = ({
    cashBalance = 0,
    balanceInitialized = false,
    unpaidFixedCosts = 0,
    essentialBudget = 0,
    savingsFund = 0,
    daysRemaining = 0,
    totalCycleDays = 0,
    inventoryValue = 0,
    expiredInventoryValue = 0,
    wastedValue = 0,
    bonusWis = 0,
    calculatedAt = new Date()
} = {}) => {
    const safeEssentialBudget = toAmount(essentialBudget);
    const safeSavingsFund = toAmount(savingsFund);
    const safeInventoryValue = toAmount(inventoryValue);
    const safeExpiredInventoryValue = toAmount(expiredInventoryValue);
    const safeWastedValue = toAmount(wastedValue);
    const safeBonusWis = toAmount(bonusWis);
    
    const hasCycleDays = Number(totalCycleDays) > 0;
    const safeDaysRemaining = Math.max(1, Number(daysRemaining) || 1);
    const safeTotalCycleDays = Math.max(1, Number(totalCycleDays) || 1);
    const budgetConfigured = balanceInitialized && safeEssentialBudget > 0;
    const coverageSignals = [balanceInitialized, safeEssentialBudget > 0, hasCycleDays];
    const dataCoverage = Math.round((coverageSignals.filter(Boolean).length / coverageSignals.length) * 100) / 100;

    // Tính toán Tiền mặt tự do (Free Cash)
    const unpaidFixed = toAmount(unpaidFixedCosts);
    const totalRemainingCash = Number(cashBalance) || 0;
    const freeCash = totalRemainingCash - unpaidFixed;

    // Tính toán HP (Máu)
    const dailyEssentialNeed = safeEssentialBudget / safeTotalCycleDays;
    const requiredSurvivalFunds = dailyEssentialNeed * safeDaysRemaining;
    const usableInventoryValue = Math.min(safeInventoryValue, requiredSurvivalFunds);
    const availableSurvivalAssets = freeCash + usableInventoryValue;
    
    const hp = budgetConfigured
        ? Math.round(clamp(100 * availableSurvivalAssets / Math.max(requiredSurvivalFunds, 1)))
        : 0;

    // Tính toán MANA (Quỹ linh hoạt)
    const requiredHoldCash = Math.max(0, requiredSurvivalFunds - usableInventoryValue);
    const mana = budgetConfigured ? Math.max(0, freeCash - requiredHoldCash) : 0;

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
                ['USABLE_INVENTORY_VALUE', usableInventoryValue],
                ['TOTAL_INVENTORY_VALUE', safeInventoryValue],
                ['EXPIRED_INVENTORY_VALUE', safeExpiredInventoryValue],
                ['REQUIRED_SURVIVAL_FUNDS', requiredSurvivalFunds],
                ['DAILY_ESSENTIAL_NEED', dailyEssentialNeed],
                ['DAYS_REMAINING', safeDaysRemaining]
            ]),
            mana: factors([
                ['FREE_CASH', freeCash],
                ['REQUIRED_HOLD_CASH', requiredHoldCash],
                ['MANA_VND', mana],
                ['SHORTFALL', Math.max(0, requiredHoldCash - freeCash)]
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

        const account = await finance.snapshot(user);
        const { startDate, endDate, now, totalDays: totalCycleDays, daysRemaining } = account.cycle;
        const essentialBudget = user.essentialBudget || 0;
        // Các món người dùng vẫn đang ghi nhận là còn trong kho.
        const activeItems = await Item.find({
            userId,
            usageStatus: 'ACTIVE'
        });

        const inventoryValue = activeItems.reduce((sum, item) => sum + exports.inventoryValue(item, now), 0);
        const expiredInventoryValue = activeItems.reduce((sum, item) => {
            if (!item.expiryDate || !moment(item.expiryDate).tz(finance.TZ).startOf('day')
                .isBefore(moment(now).tz(finance.TZ).startOf('day'))) return sum;
            return sum + exports.inventoryValue(item, now);
        }, 0);

        // Lấy các món bị vứt bỏ (Wasted) trong chu kỳ này để trừ điểm WIS
        const wastedItems = await Item.find({
            userId,
            usageStatus: 'WASTED',
            updatedAt: { $gte: startDate, $lte: endDate }
        });

        const wastedValue = wastedItems.reduce((sum, item) => sum + exports.inventoryValue(item, now, true), 0);
        const state = exports.calculateRpgState({
            cashBalance: account.cash, balanceInitialized: account.initialized, unpaidFixedCosts: account.unpaidFixed,
            essentialBudget, savingsFund: account.savings, daysRemaining, totalCycleDays,
            inventoryValue, expiredInventoryValue, wastedValue,
            bonusWis: user.rpgStats?.bonusWis || 0, calculatedAt: now
        });
        // User cũ có thể chưa có subdocument này; gán lazily để không cần migration.
        user.rpgStats ||= {};
        // Chỉ ghi các field tương thích ngược vào subdocument hiện có.
        Object.assign(user.rpgStats, state);

        // Chỉ cập nhật stat tính toán, tránh ghi đè XP/bonus từ giao dịch đồng thời.
        await User.updateOne({ _id: userId }, { $set: Object.fromEntries(
            Object.entries(state).map(([key, value]) => [`rpgStats.${key}`, value])) });

        return user.rpgStats;

    } catch (error) {
        console.error('[RPG Service] Lỗi khi tính toán chỉ số Gamification:', error);
        return null;
    }
};

exports.RPG_FORMULA_VERSION = RPG_FORMULA_VERSION;
exports.WIS_BASELINE = WIS_BASELINE;
exports.FALLBACK_WASTE_PENALTY = FALLBACK_WASTE_PENALTY;

// Đơn giá mua × số lượng còn lại; món chín lưu giá theo khẩu phần.
exports.inventoryValue = (item, now = new Date(), includeWaste = false) => {
    const food = new Set(['MEAT', 'SEAFOOD', 'VEGETABLE', 'FRUIT', 'EGG', 'DRY_FOOD', 'DRINK']);
    if (!item.isCookedMeal && !food.has(item.category)) return 0;
    // HP phản ánh lượng thực phẩm còn ghi nhận trong kho. Hạn mặc định có thể lệch thực tế;
    // chỉ ngừng tính khi người dùng dùng hết hoặc chuyển trạng thái vứt bỏ.
    return toAmount(item.purchasePrice) * toAmount(item.quantity);
};
