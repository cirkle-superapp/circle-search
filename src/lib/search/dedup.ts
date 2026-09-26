// @ts-nocheck
/**
 * dedup.ts
 * -----------------------------------------------------------------------------
 * Duplicate detection (§6). Detects:
 *   - exact duplicates (contentHash matches)
 *   - near duplicates (simhash within Hamming distance ≤ 4)
 *
 * On a duplicate, returns:
 *   - originalDocId (the existing doc we matched against)
 *   - clusterKey (the cluster identifier — derived from the original's
 *     contentHash prefix OR a new one if this is the first in a cluster).
 *
 * All DB access goes through `import { db } from '@/lib/db'`.
 * -----------------------------------------------------------------------------
 */

import { db } from '@/lib/db'

export interface DedupResult {
  isExactDuplicate: boolean
  isNearDuplicate: boolean
  clusterKey: string | null
  originalDocId?: string
}

/**
 * XOR of two hex strings, returned as a bigint. Both must have the same length.
 */
function xorHex(a: string, b: string): bigint {
  const bigA = BigInt('0x' + (a || '0'))
  const bigB = BigInt('0x' + (b || '0'))
  return bigA ^ bigB
}

/**
 * Hamming distance between two 64-bit hex strings.
 * Returns the number of set bits in (a XOR b).
 */
export function hammingDistance64(aHex: string, bHex: string): number {
  const x = xorHex(aHex, bHex)
  // Population count via BigInt
  let count = 0
  let v = x
  while (v > 0n) {
    v &= (v - 1n)
    count++
  }
  return count
}

/**
 * Find an exact or near duplicate of the given (contentHash, simhash, title).
 *
 * Looks at:
 *   1. Documents with the same contentHash → exact duplicate.
 *   2. Documents with the same domain AND a simhash within Hamming ≤ 4 → near.
 *   3. Documents with the same title AND same domain → near.
 *
 * Returns the first match found (exact preferred over near). If no match,
 * returns isOriginal=true with a new clusterKey derived from contentHash.
 */
export async function findDuplicate(
  contentHash: string,
  simhash: string,
  title: string,
  domain: string
): Promise<DedupResult> {
  // 1) Exact by contentHash
  if (contentHash) {
    const exact = await db.document.findFirst({
      where: { contentHash },
      select: { id: true, clusterId: true, domain: true },
    })
    if (exact) {
      return {
        isExactDuplicate: true,
        isNearDuplicate: false,
        clusterKey: exact.clusterId ?? contentHash.slice(0, 12),
        originalDocId: exact.id,
      }
    }
  }

  // 2) Near: scan documents in the same domain (cheap index lookup), then
  //    compute Hamming distance to each. We also fall back to scanning the
  //    most recent 200 docs if no docs in this domain have a simhash.
  let pool: { id: string; simhash: string | null; clusterId: string | null; title: string; domain: string }[] = []
  if (domain) {
    pool = await db.document.findMany({
      where: { domain, simhash: { not: null } },
      select: { id: true, simhash: true, clusterId: true, title: true, domain: true },
      take: 200,
    })
  }
  if (pool.length === 0) {
    // Fall back to global recent docs with simhash
    pool = await db.document.findMany({
      where: { simhash: { not: null } },
      select: { id: true, simhash: true, clusterId: true, title: true, domain: true },
      orderBy: { crawledAt: 'desc' },
      take: 200,
    })
  }

  for (const doc of pool) {
    if (!doc.simhash) continue
    const hd = hammingDistance64(simhash, doc.simhash)
    if (hd <= 4) {
      return {
        isExactDuplicate: false,
        isNearDuplicate: true,
        clusterKey: doc.clusterId ?? contentHash.slice(0, 12),
        originalDocId: doc.id,
      }
    }
    // Title match in same domain as additional near signal
    if (
      doc.domain === domain &&
      title &&
      doc.title &&
      title.toLowerCase() === doc.title.toLowerCase() &&
      title.length > 8
    ) {
      return {
        isExactDuplicate: false,
        isNearDuplicate: true,
        clusterKey: doc.clusterId ?? contentHash.slice(0, 12),
        originalDocId: doc.id,
      }
    }
  }

  // 3) No duplicate found — this is the first / original.
  return {
    isExactDuplicate: false,
    isNearDuplicate: false,
    clusterKey: contentHash ? contentHash.slice(0, 12) : null,
    originalDocId: undefined,
  }
}
