import mongoose from 'mongoose';

// A short passage of a policy document. Questions are matched against these.
const policyChunkSchema = new mongoose.Schema({
  docId: { type: mongoose.Schema.Types.ObjectId, ref: 'PolicyDoc', index: true, required: true },
  docTitle: { type: String, default: '' },
  index: { type: Number, default: 0 }, // position in the document
  heading: { type: String, default: '' }, // nearest section heading, if found
  text: { type: String, required: true },
  embedding: { type: [Number], default: undefined }, // optional vector for meaning-based search
});

export default mongoose.model('PolicyChunk', policyChunkSchema);
