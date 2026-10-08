// Display and AI share the same labels and values; RPG formulas remain unchanged.
exports.build = stats => {
 const f=(group,code)=>Number(stats.statBreakdown?.[group]?.find(x=>x.code===code)?.value)||0;
 const money=n=>Math.round(n).toLocaleString('vi-VN')+' đ';
 const days=f('hp','DAYS_REMAINING');
 const risk=f('hp','AT_RISK_INVENTORY_VALUE');
 const hold=f('mana','REQUIRED_HOLD_CASH');
 return {
  hp:[`Dự kiến tiền ăn cho ${days} ngày còn lại: ${money(f('hp','REQUIRED_SURVIVAL_FUNDS'))}`,`Giá trị thực phẩm trong kho: ${money(f('hp','TOTAL_INVENTORY_VALUE'))}`,
   ...(risk>0?[`Giá trị thực phẩm sắp quá hạn: ${money(risk)}`]:[]),
   ...(hold>0?[`Tiền cần giữ thêm cho ăn: ${money(hold)}`]:[])],
  mana:[`Tiền sinh hoạt thực có: ${money(f('hp','TOTAL_REMAINING_CASH'))}`,`Giữ cho khoản cố định: ${money(f('hp','UNPAID_FIXED_COSTS'))}`,`Tiền chi tiêu linh hoạt: ${money(Number(stats.mana)||0)} cho ${days} ngày`],
  def:[`Quỹ dự phòng: ${money(f('def','SAVINGS_FUND'))}`,`Bằng ${stats.def}% ngân sách ăn mỗi kỳ (${money(f('def','ESSENTIAL_BUDGET'))})`],
  wis:[`Điểm cộng trong kỳ: ${f('wis','CYCLE_BONUS_WIS')}`,`Điểm trừ do lãng phí trong kỳ: ${f('wis','WASTE_PENALTY')}`,`Điểm cộng tích lũy: ${f('wis','BONUS_WIS')}`, 'WIS được làm tròn đến điểm nguyên.']
 };
};
