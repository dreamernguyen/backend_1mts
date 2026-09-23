const moment = require('moment-timezone');
const User = require('../models/user.model');
const Transaction = require('../models/transaction.model');
const TZ = 'Asia/Ho_Chi_Minh';
const NORMAL_FILTER = { financeKind: { $nin: ['TRANSFER', 'ADJUSTMENT'] } };
const FIXED_LABELS = { RENT: 'Tiền nhà', POWER: 'Tiền điện', WATER: 'Tiền nước', OTHER: 'Cố định khác' };
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

function inferFixedCode(input = {}) {
    if (input.transactionType !== 'EXPENSE' || input.category !== 'HOUSING') return null;
    const text = `${input.note || ''} ${input.merchantName || ''}`.normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toLowerCase();
    if (/\b(dien|electric|power)\b/.test(text)) return 'POWER';
    if (/\b(nuoc|water)\b/.test(text)) return 'WATER';
    return 'RENT';
}

function cycleDates(day = 1, instant = new Date()) {
    const now = moment(instant).tz(TZ);
    const start = now.clone().startOf('month').date(Math.min(28, Math.max(1, day)));
    if (now.isBefore(start)) start.subtract(1, 'month');
    const end = start.clone().add(1, 'month');
    return {
        key: start.format('YYYY-MM-DD'), startDate: start.toDate(), endExclusive: end.toDate(),
        endDate: end.clone().subtract(1, 'millisecond').toDate(), now: now.toDate(),
        totalDays: end.diff(start, 'days'),
        daysRemaining: end.diff(now.clone().startOf('day'), 'days'),
        daysPassed: now.clone().startOf('day').diff(start, 'days') + 1
    };
}

function userCycle(user, instant = new Date()) {
    const pending = user.finance?.pendingCycleAt;
    // Kỳ chuyển tiếp bắt đầu tại biên cũ, kết thúc ở ngày lương mới kế tiếp.
    if (pending && new Date(instant) >= new Date(pending)) {
        const regular = cycleDates(user.finance.pendingCycleDay, instant);
        if (regular.startDate < new Date(pending)) {
            regular.startDate = new Date(pending);
            regular.key = moment(pending).tz(TZ).format('YYYY-MM-DD');
            regular.totalDays = moment(regular.endExclusive).diff(moment(pending), 'days');
            regular.daysPassed = moment(instant).tz(TZ).startOf('day').diff(moment(pending), 'days') + 1;
        }
        return regular;
    }
    return cycleDates(user.cycleStartDay || 1, instant);
}

function balanceFromTransactions(user, transactions) {
    let cash = Number(user.finance?.openingCash || 0);
    let savings = Number(user.finance?.openingSavings || 0);
    for (const tx of transactions) {
        if (!tx.balanceTracked) continue;
        cash += Number(tx.cashDelta || 0);
        savings += Number(tx.savingsDelta || 0);
    }
    return { cash: Math.round(cash), savings: Math.round(savings) };
}

function fixedState(plans, transactions, cycleKey) {
    return plans.map(plan => {
        const payments = transactions.filter(tx => tx.financeKind !== 'TRANSFER' && tx.financeKind !== 'ADJUSTMENT'
            && tx.transactionType === 'EXPENSE' && tx.fixedPayment?.code === plan.code
            && tx.fixedPayment?.cycleKey === cycleKey);
        const paid = payments.reduce((sum, tx) => sum + tx.amount, Number(plan.openingPaid || 0));
        const closed = payments.some(tx => tx.fixedPayment.closes);
        return { code: plan.code, cycleKey, label: FIXED_LABELS[plan.code], planned: plan.amount, paid, closed,
            remaining: closed ? 0 : Math.max(0, plan.amount - paid) };
    });
}

function fixedCyclesThrough(user, instant = new Date()) {
    const current = userCycle(user, instant);
    const cycles = (user.finance?.fixedCycles || []).map(cycle => ({
        key: cycle.key, startDate: new Date(cycle.startDate), endExclusive: new Date(cycle.endExclusive), plans: cycle.plans
    })).sort((a, b) => a.startDate - b.startDate);
    const plans = user.finance?.fixedPlans?.length ? user.finance.fixedPlans : [{ code: 'OTHER', amount: user.fixedBudget || 0 }];
    let cursor = cycles.length ? cycles.at(-1).endExclusive : current.startDate;
    // Khôi phục cả kỳ không mở ứng dụng: nghĩa vụ chưa trả không biến mất.
    while (cursor <= current.startDate) {
        const next = userCycle(user, cursor);
        const startDate = new Date(cursor);
        cycles.push({ key: moment(startDate).tz(TZ).format('YYYY-MM-DD'), startDate, endExclusive: next.endExclusive, plans });
        if (next.endExclusive <= cursor) break;
        cursor = next.endExclusive;
    }
    return cycles;
}

async function snapshot(user, session = null, instant = new Date()) {
    const cycle = userCycle(user, instant);
    const transactions = await Transaction.find({ userId: user._id,
        $or: [{ balanceTracked: true }, { 'fixedPayment.cycleKey': { $exists: true } }]
    }).select('amount transactionType financeKind cashDelta savingsDelta balanceTracked fixedPayment').session(session).lean();
    const balance = balanceFromTransactions(user, transactions);
    const fixedCosts = fixedCyclesThrough(user, instant).flatMap(saved => fixedState(saved.plans, transactions, saved.key))
        .filter(cost => cost.cycleKey === cycle.key || cost.remaining > 0);
    return { initialized: !!user.finance?.initializedAt, initializedAt: user.finance?.initializedAt || null,
        ...balance, cycle, fixedCosts, unpaidFixed: fixedCosts.reduce((sum, cost) => sum + cost.remaining, 0) };
}

// Mọi thao tác tiền dùng cùng khóa ghi trong session để tránh rút đồng thời
// và xung đột khởi tạo / tạo / xóa giao dịch.
async function lockUser(userId, session) {
    const user = await User.findByIdAndUpdate(userId, { $inc: { 'finance.revision': 1 } }, { new: true, session });
    if (!user) throw fail('Không tìm thấy người dùng.', 404);
    if (user.finance?.pendingCycleAt) {
        const firstBoundary = cycleDates(user.finance.pendingCycleDay, user.finance.pendingCycleAt).endExclusive;
        if (new Date() >= firstBoundary) {
            user.cycleStartDay = user.finance.pendingCycleDay;
            user.finance.pendingCycleDay = null;
            user.finance.pendingCycleAt = null;
            await user.save({ session });
        }
    }
    return user;
}

async function captureCycle(user, session, instant = new Date()) {
    const cycle = userCycle(user, instant);
    const existing = new Set(user.finance.fixedCycles.map(item => item.key));
    const missing = fixedCyclesThrough(user, instant).filter(item => !existing.has(item.key));
    if (missing.length) {
        user.finance.fixedCycles.push(...missing);
        await user.save({ session });
    }
    return cycle;
}

async function transactionFields(user, input, session, instant = new Date()) {
    const date = moment(input.date || instant).tz(TZ);
    if (!date.isValid() || date.isAfter(moment(instant).tz(TZ).endOf('day'))) throw fail('Ngày giao dịch không được ở tương lai.');
    const openingDay = user.finance?.initializedAt && moment(user.finance.initializedAt).tz(TZ).startOf('day');
    // Giao dịch mới ghi trong ngày khởi tạo là biến động mới; ngày cũ chỉ bổ sung lịch sử.
    const tracked = !!openingDay && !date.isBefore(openingDay);
    const fields = { financeKind: 'NORMAL', balanceTracked: tracked,
        cashDelta: tracked ? (input.transactionType === 'INCOME' ? 1 : -1) * Math.round(input.amount) : 0, savingsDelta: 0 };
    const inferredCode = input.fixedPayment?.code || (tracked ? inferFixedCode(input) : null);
    if (inferredCode) {
        if (input.transactionType !== 'EXPENSE' || !FIXED_LABELS[inferredCode]) throw fail('Khoản cố định chỉ gắn với giao dịch chi hợp lệ.');
        const cycle = await captureCycle(user, session, instant);
        const state = await snapshot(user, session, instant);
        const requestedCycleKey = input.fixedPayment?.cycleKey || userCycle(user, date.toDate()).key;
        let obligation = state.fixedCosts.find(item => item.code === inferredCode
            && item.cycleKey === requestedCycleKey && item.remaining > 0);
        if (!obligation && !input.fixedPayment?.code) {
            obligation = state.fixedCosts.filter(item => item.code === inferredCode && item.remaining > 0)
                .sort((a, b) => b.cycleKey.localeCompare(a.cycleKey))[0];
        }
        // Tự động gắn chỉ khi người dùng thực sự có dự kiến cho loại chi phí này.
        // Giao dịch HOUSING thông thường vẫn được lưu nếu chưa cấu hình kế hoạch.
        if (!obligation) {
            if (input.fixedPayment?.code) throw fail('Khoản cố định không tồn tại hoặc đã thanh toán xong.', 409);
        } else {
            fields.fixedPayment = {
                code: inferredCode,
                cycleKey: obligation.cycleKey,
                closes: input.fixedPayment?.code
                    ? input.fixedPayment.closes === true
                    : true
            };
        }
    }
    return fields;
}

function money(value, label) {
    const amount = Number(value);
    if (!Number.isSafeInteger(amount) || amount < 0) throw fail(`${label} phải là số nguyên VND không âm.`);
    return amount;
}

module.exports = { TZ, NORMAL_FILTER, FIXED_LABELS, fail, money, cycleDates, userCycle,
    balanceFromTransactions, fixedState, fixedCyclesThrough, snapshot, lockUser, captureCycle,
    inferFixedCode, transactionFields };
