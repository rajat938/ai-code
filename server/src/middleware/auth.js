import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Missing token' });
  try {
    req.admin = jwt.verify(token, config.jwtSecret);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired token' });
  }
}
