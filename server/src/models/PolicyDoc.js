import mongoose from 'mongoose';

// A company policy document uploaded by an admin (PDF, Word or typed text)
const policyDocSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    filename: { type: String, default: '' },
    type: { type: String, enum: ['pdf', 'docx', 'txt', 'text'], default: 'text' },
    text: { type: String, default: '' }, // full extracted text
    size: { type: Number, default: 0 }, // original file size in bytes
    chunkCount: { type: Number, default: 0 },
    embedded: { type: Boolean, default: false }, // passages have meaning-search vectors
    enabled: { type: Boolean, default: true },
    uploadedBy: { type: String, default: '' },
  },
  { timestamps: true }
);

export default mongoose.model('PolicyDoc', policyDocSchema);
