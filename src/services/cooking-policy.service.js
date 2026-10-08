'use strict';
const { canonicalizeName, classifyIngredientRelation, scaleIngredientAmount, toBaseAmount } = require('./recipe-matching.service');
function validateIntent(value) {
 const query = String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
 if (!query || query.length > 300) return 'Yêu cầu cần từ 1 đến 300 ký tự.';
 const text = canonicalizeName(query);
 if (/(?:chat doc|thuoc tru sau|thuoc diet chuot|thit nguoi|thuc pham da oi|do an da oi|thuc pham het han)/u.test(text)) return 'Cappy không hỗ trợ chế biến từ nguyên liệu nguy hiểm hoặc đã hỏng.';
 return null;
}
function technique(title) {
 const text = canonicalizeName(title);
 if (/\b(canh|sup)\b/.test(text)) return 'SOUP';
 if (/\bhap\b/.test(text)) return 'STEAM';
 if (/\b(chien|ran)\b/.test(text)) return 'FRY';
 if (/\b(sot|kho|rim)\b/.test(text)) return 'SAUCE';
 return null;
}
function validateRefinement(base, variant, query = '') {
 const a = technique(base.title), b = technique(variant.title);
 const addedSauce = /\bsot\b/.test(canonicalizeName(query)) && b === 'SAUCE' && a !== 'SOUP' && (variant.steps || []).some(step => ({ FRY: /\b(chien|ran)\b/, STEAM: /\bhap\b/, SAUCE: /\b(sot|kho|rim)\b/ }[a] || /$^/).test(canonicalizeName(step)));
 if (a && b && a !== b && !addedSauce) return 'Yêu cầu đổi nhóm chế biến thuộc luồng tạo món khác.';
 const main = (base.ingredients || []).filter(i => i.required ?? i.isCore);
 let protectedMain = main.filter(i => !/\bca (chua|tim|rot)\b/.test(canonicalizeName(i.name || i.itemName))).filter(i => /\b(trung|ca|heo|ga|bo|tom|muc|cua)\b/.test(canonicalizeName(i.name || i.itemName)));
 if (!protectedMain.length) protectedMain = main.filter(i => !/\b(muoi|tieu|duong|dau an|nuoc mam|nuoc tuong|toi|ot|gung|nuoc)\b/.test(canonicalizeName(i.name || i.itemName))).slice(0, 1);
 for (const ingredient of protectedMain) {
  if (!(variant.ingredients || []).some(i => ['EXACT', 'EQUIVALENT'].includes(classifyIngredientRelation(ingredient, { itemName: i.name || i.itemName }).level))) return 'Tinh luyện cần giữ nguyên liệu chính của món gốc. Hãy dùng tạo món khác nếu muốn đổi.';
 }
 return null;
}
function recipeIdentity(recipe) {
 return JSON.stringify({ title: canonicalizeName(recipe.title), ingredients: (recipe.ingredients || []).map(i => canonicalizeName(i.name || i.itemName)).sort(), steps: recipe.steps });
}
function applySubstitutions(recipe, choices = []) {
 if (!Array.isArray(choices) || choices.length > 20 || choices.some(c => !c || !Number.isInteger(c.index) || c.index < 0 || c.index >= (recipe.ingredients || []).length) || new Set(choices.map(c => c.index)).size !== choices.length) throw new Error('Lựa chọn thay thế không hợp lệ.');
 const ingredients = (recipe.ingredients || []).map((ingredient, index) => {
  const chosen = choices.find(c => c.index === index);
  if (!chosen) return ingredient;
  const allowed = (ingredient.allowedSubstitutions || []).find(s => canonicalizeName(typeof s === 'string' ? s : s.canonicalName) === canonicalizeName(chosen.name));
  if (!allowed) throw new Error('Nguyên liệu thay thế chưa được công thức cho phép.');
  const name = typeof allowed === 'string' ? allowed : allowed.canonicalName;
  const amountFactor = typeof allowed === 'string' ? 1 : Number(allowed.amountFactor || 1);
  return { ...ingredient, name, canonicalName: name, amount: Number(ingredient.amount) * amountFactor, substitutionConfirmed: true, allowedSubstitutions: [] };
 });
 return { ...recipe, ingredients };
}
function isCatalogVariant(base, variant) {
 const signature = recipe => (recipe.ingredients || []).map(i => canonicalizeName(i.name || i.itemName)).filter(name => !/^(muoi|tieu|duong|dau an|nuoc mam|nuoc tuong|xi dau|nuoc|toi|ot|gung)$/.test(name)).sort().join('|');
 return signature(base) !== signature(variant);
}
function shoppingShortages(recipe, analysis, servings = recipe.baseServings || 1) {
 return analysis.ingredientMatches.filter(match => match.ingredient.purchaseRequired !== false && (match.ingredient.required ?? match.ingredient.isCore)).map(match => {
  const needed = toBaseAmount(scaleIngredientAmount(match.ingredient, servings, Number(recipe.baseServings || 1)), match.ingredient.unit);
  return { name: match.ingredient.name || match.ingredient.itemName, amount: needed ? Math.round(Math.max(0, needed.amount - match.availableAmount) * 100) / 100 : null, unit: needed?.unit || match.ingredient.unit };
 }).filter(item => item.amount === null || item.amount > 0);
}
function validateRequestedDish(query, recipe) {
 const text = canonicalizeName(query);
 if (/\b(mi|my) cay\b/.test(text)) {
  const names = (recipe.ingredients || []).filter(item => item.required ?? item.isCore).map(item => canonicalizeName(item.name));
  if (!names.some(name => /\b(mi|my)\b/.test(name) && !/\bbot\b/.test(name))) return 'Cappy chưa tạo đủ thành phần mì cho món được yêu cầu. Hãy thử lại.';
  if (/\bhai san\b/.test(text) && !names.some(name => /\b(tom|muc|ngheu|so|cua)\b/.test(name) && !/\b(sa te|bot|nuoc mam|dau)\b/.test(name))) return 'Công thức chưa có hải sản phù hợp với yêu cầu. Hãy thử lại.';
 }
 return null;
}
module.exports = { validateRequestedDish, shoppingShortages, isCatalogVariant, applySubstitutions, validateIntent, validateRefinement, recipeIdentity };
