'use strict';
// Vercel entry point: every API route is rewritten here by vercel.json.
// If the server cannot even load (missing module, bad runtime, syntax error), answer with a readable JSON error
// instead of Vercel's bare FUNCTION_INVOCATION_FAILED, so the dashboard shows what is wrong. Details go to the Vercel log.
let handler = null, loadError = null;
try { handler = require('../server/index').handler; }
catch (e) { loadError = e; console.error('[startup] server failed to load:', e); }

process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

module.exports = async (req, res) => {
  if (handler) return handler(req, res);
  res.statusCode = 500;
  res.setHeader('content-type', 'application/json');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify({ error: { type: 'api_error', code: 'startup_failed',
    message: `Server failed to start on Node ${process.version}: ${String(loadError && loadError.message || loadError).split('\n')[0].slice(0, 300)}. Check the Vercel function log.` } }));
};
