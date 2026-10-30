import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: ['user', 'assistant'], required: true },
    content: { type: String, default: '' },
    error: { type: String, default: '' },
    blocked: { type: Boolean, default: false }, // reply was a policy refusal
    sources: { type: [{ _id: false, docId: String, title: String }], default: undefined }, // policy documents used
    durationMs: { type: Number, default: 0 },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } }
);

// One chat thread. clientId identifies the browser that owns it (stored in the browser's localStorage).
const conversationSchema = new mongoose.Schema(
  {
    clientId: { type: String, required: true, index: true },
    title: { type: String, default: 'New chat' },
    model: { type: String, default: '' },
    messages: { type: [messageSchema], default: [] },
  },
  { timestamps: true }
);

conversationSchema.index({ clientId: 1, updatedAt: -1 });

export default mongoose.model('Conversation', conversationSchema);
