import mongoose from 'mongoose';

// A restricted topic: if a prompt matches any of its keywords, it is blocked
// before it reaches the AI model.
const ruleSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  // Words or phrases, matched as whole words, case-insensitive. Use * as a wildcard (e.g. "salar*").
  keywords: { type: [String], default: [] },
  // Optional: a regular expression for advanced matching
  pattern: { type: String, default: '' },
  // Reply shown to the user when this rule blocks a prompt (falls back to the default message)
  message: { type: String, default: '' },
  enabled: { type: Boolean, default: true },
});

// Single document holding all assistant / policy settings
const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    assistantName: { type: String, default: 'Company Assistant' },
    // Shown to staff above the chat (short)
    userNotice: { type: String, default: '' },
    // Company policies / instructions sent to the model as the system prompt
    systemPrompt: { type: String, default: '' },
    // Reply used when a rule has no message of its own
    defaultBlockMessage: { type: String, default: '' },
    rules: { type: [ruleSchema], default: [] },
    // ---- Policy documents (Admin → Knowledge) ----
    kbEnabled: { type: Boolean, default: true }, // answer from uploaded policy documents
    kbStrict: { type: Boolean, default: false }, // only answer questions found in the documents
    kbTopK: { type: Number, default: 3, min: 1, max: 6 }, // passages given to the AI per question
    kbNotFoundMessage: { type: String, default: '' },
    updatedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model('Settings', settingsSchema);
