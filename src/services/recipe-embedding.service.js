'use strict';

const { TaskType } = require('@google/generative-ai');
const geminiService = require('./gemini.service');

const QUERY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const QUERY_CACHE_MAX_ENTRIES = 200;
const queryEmbeddingCache = new Map();

function compact(value) {
    return String(value || '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

function buildRecipeEmbeddingText(recipe) {
    const ingredients = (recipe.ingredients || [])
        .map(item => compact(item.name || item.canonicalName || item.itemName))
        .filter(Boolean);
    const methods = (recipe.steps || [])
        .slice(0, 3)
        .map(step => compact(typeof step === 'string' ? step : step?.instruction))
        .filter(Boolean);
    return [
        `Tên món: ${compact(recipe.title)}`,
        ingredients.length ? `Nguyên liệu: ${ingredients.join(', ')}` : '',
        recipe.dishType ? `Loại món: ${compact(recipe.dishType)}` : '',
        (recipe.tags || []).length ? `Nhãn: ${recipe.tags.map(compact).join(', ')}` : '',
        recipe.description ? `Mô tả: ${compact(recipe.description)}` : '',
        methods.length ? `Cách nấu: ${methods.join(' ')}` : ''
    ].filter(Boolean).join('\n');
}

async function embedRecipeDocument(recipe) {
    return geminiService.embedText(buildRecipeEmbeddingText(recipe), {
        taskType: TaskType.RETRIEVAL_DOCUMENT,
        title: compact(recipe.title)
    });
}

async function embedRecipeQuery(query) {
    const normalizedQuery = compact(query).slice(0, 300);
    const cached = queryEmbeddingCache.get(normalizedQuery);
    if (cached && cached.expiresAt > Date.now()) return cached.vector;
    const vector = await geminiService.embedText(normalizedQuery, {
        taskType: TaskType.RETRIEVAL_QUERY
    });
    if (queryEmbeddingCache.size >= QUERY_CACHE_MAX_ENTRIES) {
        queryEmbeddingCache.delete(queryEmbeddingCache.keys().next().value);
    }
    queryEmbeddingCache.set(normalizedQuery, {
        vector,
        expiresAt: Date.now() + QUERY_CACHE_TTL_MS
    });
    return vector;
}

module.exports = {
    EMBEDDING_DIMENSIONS: geminiService.RECIPE_EMBEDDING_DIMENSIONS,
    EMBEDDING_MODEL: geminiService.RECIPE_EMBEDDING_MODEL,
    buildRecipeEmbeddingText,
    embedRecipeDocument,
    embedRecipeQuery
};
