// api/process-commissions.ts
// ═══════════════════════════════════════════════════════════════
// POST /api/process-commissions (internal only)
//
// ✅ Production-grade, high-concurrency safe, Vercel-optimized
// ✅ Fully typed — no implicit any
// ✅ Robust Firebase key parser (handles base64, PEM, quotes)
// ═══════════════════════════════════════════════════════════════

import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import type {
  DocumentData,
  QueryDocumentSnapshot,
  QuerySnapshot,
} from 'firebase-admin/firestore';

// ═══════════════════════════════════════════════════════════════
// Firebase Admin init (ROBUST)
//
// Handles every common private-key format stored in env vars:
//   A) Raw PEM with literal \n                → convert to newlines
//   B) Raw PEM with real newlines             → use as-is
//   C) Base64-encoded PEM                     → decode, then use
//   D) Value wrapped in surrounding quotes    → strip, then parse
// ═══════════════════════════════════════════════════════════════
function parseFirebaseKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  let key = raw.trim();

  if (key.startsWith('"') && key.endsWith('"')) {
    key = key.slice(1, -1).trim();
  }

  // Already a PEM
  if (key.includes('-----BEGIN')) {
    if (key.includes('\\n')) {
      return key.replace(/\\n/g, '\n');
    }
    return key;
  }

  // Try base64
  try {
    const decoded = Buffer.from(key, 'base64').toString('utf-8');
    if (decoded.includes('-----BEGIN')) {
      return decoded.includes('\\n')
        ? decoded.replace(/\\n/g, '\n')
        : decoded;
    }
  } catch {
    /* fall through */
  }

  return key;
}

if (!admin.apps.length) {
  const firebaseKey = parseFirebaseKey(process.env.FIREBASE_PRIVATE_KEY);

  console.log(
    '[process-commissions] FIREBASE key starts:',
    firebaseKey?.substring(0, 30),
  );
  console.log(
    '[process-commissions] FIREBASE key length:',
    firebaseKey?.length,
  );

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: firebaseKey,
    }),
  });
}

const db = admin.firestore();

// ═══════════════════════════════════════════════════════════════
// Plan configuration (mirrors lib/models/plan_model.dart)
// ═══════════════════════════════════════════════════════════════
interface PlanConfig {
  tier: 'bronze' | 'silver' | 'gold';
  depth: number;
  directPct: number;
  networkPct: number;
  pricePkr: number;
}

const PLAN_TABLE: Record<string, PlanConfig> = {
  refero_bronze: { tier: 'bronze', depth: 3, directPct: 20, networkPct: 5, pricePkr: 1500 },
  refero_silver: { tier: 'silver', depth: 6, directPct: 20, networkPct: 5, pricePkr: 3000 },
  refero_gold:   { tier: 'gold',   depth: 10, directPct: 20, networkPct: 5, pricePkr: 5000 },
  refero_bronze_lifetime: { tier: 'bronze', depth: 3, directPct: 20, networkPct: 5, pricePkr: 45000 },
  refero_silver_lifetime: { tier: 'silver', depth: 6, directPct: 20, networkPct: 5, pricePkr: 90000 },
  refero_gold_lifetime:   { tier: 'gold',   depth: 10, directPct: 20, networkPct: 5, pricePkr: 120000 },
};

const MAX_UPLINE_WALK = 10;

interface CommissionRecipient {
  userId: string;
  amount: number;
  type: 'direct' | 'network';
  level: number;
  frozen: boolean;
  tier: string;
}

interface UplineNode {
  userId: string;
  tier: string;
  isActive: boolean;
  referralCode: string;
}

// ═══════════════════════════════════════════════════════════════
// Handler — unchanged from your version
// ═══════════════════════════════════════════════════════════════
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const providedKey = req.headers['x-internal-key'];
  if (!providedKey || providedKey !== process.env.INTERNAL_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { userId, subscriptionId, productId, amount } = req.body || {};

  if (!userId || !subscriptionId || typeof amount !== 'number' || amount <= 0) {
    res.status(400).json({ error: 'Invalid payload' });
    return;
  }

  const planConfig = PLAN_TABLE[productId];
  if (!planConfig) {
    res.status(400).json({ error: `Unknown productId: ${productId}` });
    return;
  }

  const subRef = db.collection('subscriptions').doc(subscriptionId);

  try {
    // ═══════════════════════════════════════════════════════
    // STEP 1: Atomic claim (idempotency + concurrency guard)
    // ═══════════════════════════════════════════════════════
    const claimed: boolean = await db.runTransaction(async (tx) => {
      const subDoc = await tx.get(subRef);
      if (!subDoc.exists) return false;
      if (subDoc.data()?.commissionsProcessed === true) return false;

      tx.update(subRef, {
        commissionsProcessed: true,
        commissionsProcessedAt: admin.firestore.FieldValue.serverTimestamp(),
        commissionsClaimedBy: `req-${Date.now()}`,
      });
      return true;
    });

    if (!claimed) {
      res.status(200).json({ status: 'already_processed' });
      return;
    }

    // ═══════════════════════════════════════════════════════
    // STEP 2: Fetch trigger user
    // ═══════════════════════════════════════════════════════
    const triggerUserDoc = await db.collection('users').doc(userId).get();
    if (!triggerUserDoc.exists) {
      res.status(200).json({ status: 'user_not_found' });
      return;
    }
    const triggerUser: DocumentData = triggerUserDoc.data()!;
    const triggerName: string = triggerUser.fullName || 'Someone';

    if (!triggerUser.referredBy) {
      await subRef.update({
        commissionsDistributed: 0,
        commissionsRecipients: 0,
        commissionsReason: 'no_referrer',
      });
      res.status(200).json({ status: 'no_referrer' });
      return;
    }

    // ═══════════════════════════════════════════════════════
    // STEP 3: Walk upline chain
    // ═══════════════════════════════════════════════════════
    const chain: UplineNode[] = await buildUplineChain(triggerUser.referredBy);

    if (chain.length === 0) {
      await subRef.update({
        commissionsDistributed: 0,
        commissionsRecipients: 0,
        commissionsReason: 'no_upline',
      });
      res.status(200).json({ status: 'no_upline' });
      return;
    }

    // ═══════════════════════════════════════════════════════
    // STEP 4: Compute credits
    // ═══════════════════════════════════════════════════════
    const directAmount = (amount * planConfig.directPct) / 100;
    const networkAmount = (amount * planConfig.networkPct) / 100;

    const credits: CommissionRecipient[] = [];

    for (let i = 0; i < chain.length; i++) {
      const level = i + 1;
      const recipient = chain[i];

      const recipientDepth = getDepthForTier(recipient.tier);
      if (level > recipientDepth) break;

      if (recipient.tier === 'free' || recipientDepth === 0) continue;

      const creditAmount = level === 1 ? directAmount : networkAmount;

      credits.push({
        userId: recipient.userId,
        amount: creditAmount,
        type: level === 1 ? 'direct' : 'network',
        level,
        frozen: !recipient.isActive,
        tier: recipient.tier,
      });
    }

    if (credits.length === 0) {
      await subRef.update({
        commissionsDistributed: 0,
        commissionsRecipients: 0,
        commissionsReason: 'no_eligible_recipients',
      });
      res.status(200).json({ status: 'no_eligible_recipients' });
      return;
    }

    // ═══════════════════════════════════════════════════════
    // STEP 5: Bulk write
    // ═══════════════════════════════════════════════════════
    const bulkWriter = db.bulkWriter();
    bulkWriter.onWriteError((error) => {
      console.error('[bulkWriter] write error:', error.message);
      return error.failedAttempts < 3;
    });

    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const planName = getPlanDisplayName(productId);
    let totalDistributed = 0;

    for (const credit of credits) {
      const userRef = db.collection('users').doc(credit.userId);

      if (credit.frozen) {
        bulkWriter.update(userRef, {
          pendingBalance: admin.firestore.FieldValue.increment(credit.amount),
          totalEarnings: admin.firestore.FieldValue.increment(credit.amount),
          updatedAt: timestamp,
        });
      } else {
        bulkWriter.update(userRef, {
          walletBalance: admin.firestore.FieldValue.increment(credit.amount),
          totalEarnings: admin.firestore.FieldValue.increment(credit.amount),
          updatedAt: timestamp,
        });
      }

      const historyRef = userRef.collection('earningsHistory').doc();
      bulkWriter.set(historyRef, {
        type: credit.type,
        amount: credit.amount,
        level: credit.level,
        fromUserId: userId,
        fromUserName: triggerName,
        planName,
        productId,
        frozen: credit.frozen,
        description:
          credit.type === 'direct'
            ? `Direct commission (${planConfig.directPct}%) from ${triggerName}'s ${planName}`
            : `Indirect commission (${planConfig.networkPct}%) from ${triggerName} (level ${credit.level})`,
        timestamp,
      });

      totalDistributed += credit.amount;
    }

    await bulkWriter.close();

    // ═══════════════════════════════════════════════════════
    // STEP 6: Finalize
    // ═══════════════════════════════════════════════════════
    await subRef.update({
      commissionsDistributed: totalDistributed,
      commissionsRecipients: credits.length,
      commissionsFrozen: credits.filter((c) => c.frozen).length,
      updatedAt: timestamp,
    });

    res.status(200).json({
      success: true,
      recipients: credits.length,
      totalDistributed,
      frozen: credits.filter((c) => c.frozen).length,
      details: credits,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('[process-commissions] fatal error:', err);

    try {
      await subRef.update({
        commissionsProcessed: false,
        commissionsError: err?.message || 'unknown',
      });
    } catch {
      /* ignore */
    }

    res.status(500).json({
      success: false,
      error: err?.message || 'Commission processing failed',
    });
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════
async function buildUplineChain(
  firstReferralCode: string,
): Promise<UplineNode[]> {
  const chain: UplineNode[] = [];
  let currentCode: string | null = firstReferralCode;

  for (let i = 0; i < MAX_UPLINE_WALK; i++) {
    if (!currentCode) break;

    const snap: QuerySnapshot<DocumentData> = await db
      .collection('users')
      .where('referralCode', '==', currentCode)
      .limit(1)
      .get();

    if (snap.empty) break;

    const doc: QueryDocumentSnapshot<DocumentData> = snap.docs[0];
    const data: DocumentData = doc.data();

    const isBanned: boolean = data.isBanned === true;
    const isInactive: boolean = data.isActive === false;
    const isSubActive: boolean = data.subscriptionStatus === 'active';
    const isLifetime: boolean = data.planDuration === 'lifetime';

    let hasActiveAccess = false;
    if (!isBanned && !isInactive && isSubActive) {
      if (isLifetime) {
        hasActiveAccess = true;
      } else {
        const endDate: Date | undefined = data.subscriptionEndDate?.toDate?.();
        hasActiveAccess = !endDate || endDate > new Date();
      }
    }

    chain.push({
      userId: doc.id,
      tier: (data.tier as string) || 'free',
      isActive: hasActiveAccess,
      referralCode: currentCode,
    });

    currentCode = (data.referredBy as string) || null;
  }

  return chain;
}

function getDepthForTier(tier: string): number {
  switch (tier.toLowerCase()) {
    case 'bronze':
      return 3;
    case 'silver':
      return 6;
    case 'gold':
      return 10;
    default:
      return 0;
  }
}

function getPlanDisplayName(productId: string): string {
  const map: Record<string, string> = {
    refero_bronze: 'Bronze Plan',
    refero_silver: 'Silver Plan',
    refero_gold: 'Gold Plan',
    refero_bronze_lifetime: 'Bronze Lifetime',
    refero_silver_lifetime: 'Silver Lifetime',
    refero_gold_lifetime: 'Gold Lifetime',
  };
  return map[productId] || 'Subscription';
}