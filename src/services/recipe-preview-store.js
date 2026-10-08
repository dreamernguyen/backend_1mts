'use strict';
const { randomUUID } = require('node:crypto');
const entries = new Map();
const TTL = 30 * 60 * 1000;
function put(userId, recipe, sessionId) {
    for (const [key, entry] of entries) if (entry.expires <= Date.now()) entries.delete(key);
    if (entries.size >= 500) entries.delete(entries.keys().next().value);
    const token = randomUUID();
    entries.set(token, { userId: String(userId), recipe, sessionId, expires: Date.now() + TTL, saving: null });
    return token;
}
function get(userId, token) {
    const entry = entries.get(token);
    return entry && entry.userId === String(userId) && entry.expires > Date.now() ? entry : null;
}
function findRecipe(userId, recipeId) {
 for (const entry of entries.values()) if (entry.userId === String(userId) && entry.expires > Date.now() && entry.recipe.recipeId === recipeId) return entry.recipe;
 return null;
}
module.exports = { put, get, findRecipe };
