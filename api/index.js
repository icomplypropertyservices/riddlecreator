// Vercel serverless entry — re-exports the Express app.
// All routes (/, /api/*, static) are handled by Express via vercel.json rewrites.
module.exports = require('../server');
