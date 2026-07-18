// Vercel serverless entry — re-exports the Express app with boot-error surfacing.
try {
  module.exports = require('../server');
} catch (err) {
  console.error('RiddleCreator boot failed:', err);
  module.exports = (req, res) => {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: 'boot_failed',
      message: err && err.message ? err.message : String(err),
      code: err && err.code ? err.code : undefined,
    }));
  };
}
