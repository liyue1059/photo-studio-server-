const jwt = require('jsonwebtoken');
const config = require('../config');

/**
 * JWT authentication middleware
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ code: 401, message: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = jwt.verify(token, config.jwt.secret);
    req.userId = decoded.userId;
    req.openid = decoded.openid;
    next();
  } catch (err) {
    return res.status(401).json({ code: 401, message: 'Invalid or expired token' });
  }
}

/**
 * Optional auth - attaches user if token valid, but doesn't reject
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const decoded = jwt.verify(token, config.jwt.secret);
      req.userId = decoded.userId;
      req.openid = decoded.openid;
    } catch (err) {
      // Token invalid, proceed without user
    }
  }
  next();
}

module.exports = { authMiddleware, optionalAuth };
