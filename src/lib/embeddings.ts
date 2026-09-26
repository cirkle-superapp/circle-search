// @ts-nocheck
/**
 * embeddings.ts
 * -----------------------------------------------------------------------------
 * In-process semantic embeddings using @xenova/transformers (transformers.js).
 *
 * Why transformers.js (not OpenAI/VoyageAI/Cohere embeddings API)?
 *   1. Zero external API calls — runs entirely in the Next.js process.
 *   2. Zero cost — the model is downloaded ONCE from HuggingFace CDN, then
 *      cached locally (~80MB for all-MiniLM-L6-v2).
 *   3. Zero network latency — embeddings are computed in-process (~10-50ms
 *      per sentence, vs 200-500ms for an API call).
 *   4. Privacy — the document content never leaves the server.
 *
 * Model: `Xenova/all-MiniLM-L6-v2` — 384-dim, 23M params, ~80MB download.
 * Trained on 1B sentence pairs. Hits ~50% on STS-B (good for general-purpose
 * semantic similarity).
 *
 * Usage:
 *   - At index time: `await embed(doc.title + ' ' + doc.bodyText.slice(0, 500))`
 *     → Float32Array of 384 numbers → store as `Document.embedding` BLOB.
 *   - At query time: `await embed(query)` → compare cosine similarity with
 *     each candidate doc's embedding.
 *
 * The model is lazy-loaded on first use (~3s) and cached for the process
 * lifetime. Subsequent embeds are ~30ms each.
 * -----------------------------------------------------------------------------
 */

// @xenova/transformers is server-side only (uses onnxruntime-node).
// 'use server' ensures this module never ends up in a client bundle.
import 'server-only'

let _pipeline: any = null
let _loadingPromise: Promise<any> | null = null

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2'
const EMBEDDING_DIM = 384

/**
 * Load the feature-extraction pipeline (lazy + cached).
 * The first call downloads the model (~80MB) from HuggingFace CDN. Subsequent
 * calls in the same process return the cached pipeline.
 */
async function getPipeline(): Promise<any> {
  if (_pipeline) return _pipeline
  if (_loadingPromise) return _loadingPromise
  _loadingPromise = (async () => {
    try {
      const { pipeline } = await import('@xenova/transformers')
      _pipeline = await pipeline('feature-extraction', MODEL_ID, {
        // Use the quantized version — smaller (22MB vs 80MB) + faster.
        quantized: true,
        // Don't download progress bar — pollutes logs.
        progress_callback: () => {},
      })
      return _pipeline
    } catch (e: any) {
      // Reset so a subsequent call can retry.
      _loadingPromise = null
      throw e
    }
  })()
  return _loadingPromise
}

/**
 * Compute the embedding for a piece of text.
 * Returns a Float32Array of 384 numbers (mean-pooled).
 * Truncates input to ~512 tokens (the model's max seq length) to keep
 * latency bounded.
 */
export async function embed(text: string): Promise<Float32Array | null> {
  if (!text || typeof text !== 'string') return null
  try {
    const pipe = await getPipeline()
    if (!pipe) return null
    // Truncate very long text — the model caps at 512 tokens (~1500 chars).
    const truncated = text.length > 2000 ? text.slice(0, 2000) : text
    const output = await pipe(truncated, {
      pooling: 'mean',
      normalize: true,
    })
    // Output is a Tensor — extract the data as Float32Array.
    const data = output?.data
    if (!data) return null
    const arr = data instanceof Float32Array ? data : new Float32Array(data)
    if (arr.length !== EMBEDDING_DIM) {
      // Unexpected dim — return null so the caller can fall back to BM25.
      return null
    }
    return arr
  } catch (e: any) {
    // Common failures:
    //   - Model download failed (network) → next call will retry.
    //   - onnxruntime-node binary missing (rare on Vercel) → callers fall
    //     back to BM25 only.
    return null
  }
}

/**
 * Cosine similarity between two embeddings. Both must be the same length.
 * Returns a value in [-1, 1] (1 = identical, 0 = unrelated, -1 = opposite).
 */
export function cosineSim(a: Float32Array, b: Float32Array): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/**
 * Encode an embedding Float32Array as a Buffer for storage in a BLOB column.
 */
export function encodeEmbedding(embedding: Float32Array): Buffer {
  return Buffer.from(embedding.buffer, embedding.byteOffset, embedding.byteLength)
}

/**
 * Decode a stored BLOB back into a Float32Array.
 */
export function decodeEmbedding(buf: Buffer | Uint8Array | null): Float32Array | null {
  if (!buf || buf.byteLength === 0) return null
  // The buffer should be a Float32Array's underlying ArrayBuffer.
  const byteLen = buf.byteLength
  if (byteLen % 4 !== 0) return null // Float32 = 4 bytes
  const arr = new Float32Array(
    buf instanceof Uint8Array
      ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + byteLen)
      : buf.slice(0, byteLen),
  )
  if (arr.length !== EMBEDDING_DIM) return null
  return arr
}

/**
 * Is the embedding module available? Returns false if the model failed to
 * load (e.g. onnxruntime not installed, model download failed). Callers
 * should fall back to BM25-only when this returns false.
 *
 * Performs a lazy check — if the pipeline hasn't been loaded yet, this
 * triggers the load + returns whether it succeeded.
 */
export async function isEmbeddingAvailable(): Promise<boolean> {
  try {
    const pipe = await getPipeline()
    return !!pipe
  } catch {
    return false
  }
}

export const EMBEDDING_DIMENSIONS = EMBEDDING_DIM
