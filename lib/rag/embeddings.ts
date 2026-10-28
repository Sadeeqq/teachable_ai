// ═══════════════════════════════════════════════════════════════════════════
// embeddings.ts — local, in-process embeddings via transformers.js (ONNX).
// No PyTorch, no external embedding API/cost — genuinely matches PRD §13
// (zero recurring infra cost) and §11 (Technical Stack: "open-source/local
// embedding solution").
// Model: Xenova/all-MiniLM-L6-v2 — 384 dims, ~25MB quantized.
// ═══════════════════════════════════════════════════════════════════════════

import { pipeline, type FeatureExtractionPipeline } from '@xenova/transformers';

let extractor: FeatureExtractionPipeline | null = null;

async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
  }
  return extractor;
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
  const model = await getExtractor();
  const vectors: number[][] = [];
  for (const text of texts) {
    const output = await model(text, { pooling: 'mean', normalize: true });
    vectors.push(Array.from(output.data as Float32Array));
  }
  return vectors;
}

export async function embedSingle(text: string): Promise<number[]> {
  return (await embedTexts([text]))[0];
}
