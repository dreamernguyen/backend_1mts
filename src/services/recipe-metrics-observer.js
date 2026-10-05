const { randomUUID } = require('node:crypto');

// Observe the response without adding any awaited metrics I/O to the business path.
function observeRecipe(handler, subFeature, metrics) {
    return (req, res, next) => {
        const startedAt = Date.now();
        const sessionId = subFeature === 'RAG'
            && /^[A-Za-z0-9_-]{8,150}$/.test(String(req.body?.recommendationSessionId || ''))
            ? req.body.recommendationSessionId : `recipe-${randomUUID()}`;
        const state = req.recipeMetrics = { sessionId, source: 'RULE_DB', provider: null, candidates: [] };
        let recorded = false;
        const record = (body, error) => {
            if (recorded) return;
            recorded = true;
            const data = body?.data || {};
            const recipes = subFeature === 'OVERVIEW' ? [...(data.suggested || []), ...(data.rescue || [])]
                : data.recipe ? [data.recipe] : state.candidates;
            const unique = [...new Map(recipes.filter(r => r?.recipeId).map(r => [r.recipeId, r])).values()];
            const returnedRecipeIds = subFeature === 'OVERVIEW' ? unique.map(r => r.recipeId)
                : [data.recipeId || data.recipe?.recipeId].filter(Boolean);
            try { metrics.logRecipeAiResponse({
                userId: req.user.userId, sessionId, subFeature, latencyMs: Date.now() - startedAt,
                usedAiFallback: state.source !== 'RULE_DB', recommendationSource: state.source,
                recipeId: data.recipeId || data.recipe?.recipeId || null,
                suggestionCount: returnedRecipeIds.length, returnedRecipeIds, candidates: unique,
                outcome: error || body?.success === false ? 'ERROR' : data.type || 'RECOMMENDATIONS',
                errorCode: error?.code || body?.code,
                provider: state.provider, query: subFeature === 'RAG' ? req.body?.query : undefined
            }); } catch (metricsError) {
                console.warn('[Recipe metrics] Observation failed:', metricsError.message);
            }
        };
        const json = res.json;
        res.json = function(body) {
            record(body);
            if (body?.success && body.data) {
                body.data.recommendationSessionId = sessionId;
                body.data.recommendationSource = state.source;
            }
            return json.call(this, body);
        };
        return handler(req, res, error => { record(null, error); next(error); });
    };
}
module.exports = { observeRecipe };
