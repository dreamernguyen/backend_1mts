'use strict';

const Recipe = require('../models/recipe.model');
const Sequence = require('../models/sequence.model');

const AI_RECIPE_SEQUENCE = 'ai_recipe';
const AI_RECIPE_ID_PATTERN = /^ai_recipe_(\d+)$/u;

function parseAiRecipeSequence(recipeId) {
    const match = String(recipeId || '').match(AI_RECIPE_ID_PATTERN);
    return match ? Number.parseInt(match[1], 10) : null;
}

function formatAiRecipeId(sequence) {
    if (!Number.isSafeInteger(sequence) || sequence < 1) {
        throw new TypeError('AI recipe sequence phải là số nguyên dương an toàn.');
    }
    return `ai_recipe_${String(sequence).padStart(3, '0')}`;
}

async function findHighestPersistedAiSequence() {
    const recipes = await Recipe.find({ recipeId: /^ai_recipe_\d+$/u })
        .select({ recipeId: 1, _id: 0 })
        .lean();
    return recipes.reduce((highest, recipe) =>
        Math.max(highest, parseAiRecipeSequence(recipe.recipeId) || 0), 0);
}

async function allocateAiRecipeId() {
    const persistedMaximum = await findHighestPersistedAiSequence();
    const counter = await Sequence.findOneAndUpdate(
        { _id: AI_RECIPE_SEQUENCE },
        [{
            $set: {
                value: {
                    $add: [
                        { $max: [{ $ifNull: ['$value', 0] }, persistedMaximum] },
                        1
                    ]
                }
            }
        }],
        { upsert: true, new: true }
    ).lean();
    return formatAiRecipeId(counter.value);
}

module.exports = {
    AI_RECIPE_ID_PATTERN,
    allocateAiRecipeId,
    formatAiRecipeId,
    parseAiRecipeSequence
};
