'use strict';

const Recipe = require('../models/recipe.model');
const {
    EMBEDDING_DIMENSIONS,
    embedRecipeQuery
} = require('./recipe-embedding.service');
const { publicRecipeProjection } = require('./recipe-catalog.service');

const VECTOR_INDEX = process.env.RECIPE_VECTOR_INDEX || 'recipe_vector_index';

function vectorSearchEnabled() {
    return String(process.env.RECIPE_VECTOR_SEARCH_ENABLED || '').toLowerCase() === 'true';
}

function buildSemanticPipeline(queryVector, limit = 20, postFilter = {}) {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const candidateLimit = Math.min(Math.max(safeLimit * 5, 100), 250);
    return [
        {
            $vectorSearch: {
                index: VECTOR_INDEX,
                path: 'embeddingVector',
                queryVector,
                numCandidates: Math.min(Math.max(candidateLimit * 20, 100), 5000),
                limit: candidateLimit
            }
        },
        ...(postFilter && Object.keys(postFilter).length > 0 ? [{ $match: postFilter }] : []),
        { $limit: safeLimit },
        {
            $project: {
                ...publicRecipeProjection(),
                semanticScore: { $meta: 'vectorSearchScore' }
            }
        }
    ];
}

async function semanticRecipeSearch(query, limit = 20, postFilter = {}) {
    if (!vectorSearchEnabled()) return [];
    const queryVector = await embedRecipeQuery(query);
    if (queryVector.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Query embedding phải có ${EMBEDDING_DIMENSIONS} chiều.`);
    }
    return Recipe.aggregate(buildSemanticPipeline(queryVector, limit, postFilter));
}

module.exports = { buildSemanticPipeline, semanticRecipeSearch, vectorSearchEnabled };
