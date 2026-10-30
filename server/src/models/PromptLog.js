import mongoose from 'mongoose';

const promptLogSchema = new mongoose.Schema(
  {
    prompt: { type: String, required: true },
    response: { type: String, default: '' },
    model: { type: String, required: true },
    status: { type: String, enum: ['pending', 'success', 'error', 'blocked'], default: 'pending' },
    error: { type: String, default: '' },
    durationMs: { type: Number, default: 0 },
    promptTokens: { type: Number, default: 0 },
    responseTokens: { type: Number, default: 0 },
    blockedRule: { type: String, default: '' }, // which restricted topic blocked this prompt
    sources: { type: [{ _id: false, docId: String, title: String }], default: [] }, // policy documents used
    clientId: { type: String, default: '', index: true },
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', index: true },
    ip: String,
    userAgent: String,
  },
  { timestamps: true }
);

promptLogSchema.index({ createdAt: -1 });

export default mongoose.model('PromptLog', promptLogSchema);
