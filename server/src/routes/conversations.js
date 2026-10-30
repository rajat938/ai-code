import { Router } from 'express';
import mongoose from 'mongoose';
import Conversation from '../models/Conversation.js';

const router = Router();

// The browser sends its anonymous id in this header
function clientIdOf(req) {
  const id = String(req.headers['x-client-id'] || '').trim();
  return /^[A-Za-z0-9-]{8,64}$/.test(id) ? id : null;
}

router.use((req, res, next) => {
  req.clientId = clientIdOf(req);
  if (!req.clientId) return res.status(400).json({ message: 'Missing or invalid X-Client-Id header' });
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ message: 'Database is not connected, chat history is unavailable.' });
  }
  next();
});

// List this browser's chats (newest first), without the message bodies
router.get('/', async (req, res) => {
  const items = await Conversation.find({ clientId: req.clientId })
    .sort({ updatedAt: -1 })
    .limit(100)
    .select('title model updatedAt createdAt')
    .lean();
  res.json({ items });
});

router.get('/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Bad id' });
  const conv = await Conversation.findOne({ _id: req.params.id, clientId: req.clientId }).lean();
  if (!conv) return res.status(404).json({ message: 'Conversation not found' });
  res.json(conv);
});

router.patch('/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Bad id' });
  const title = String(req.body?.title || '').trim().slice(0, 100);
  if (!title) return res.status(400).json({ message: 'Title is required' });
  const conv = await Conversation.findOneAndUpdate(
    { _id: req.params.id, clientId: req.clientId },
    { title },
    { new: true }
  ).select('title model updatedAt createdAt');
  if (!conv) return res.status(404).json({ message: 'Conversation not found' });
  res.json(conv);
});

// Deleting a chat removes it from the user's sidebar.
// The admin prompt logs are kept (they are a separate collection).
router.delete('/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Bad id' });
  await Conversation.deleteOne({ _id: req.params.id, clientId: req.clientId });
  res.json({ ok: true });
});

export { clientIdOf };
export default router;
