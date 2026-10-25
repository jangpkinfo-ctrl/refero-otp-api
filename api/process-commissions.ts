// api/process-commissions.ts
// ═══════════════════════════════════════════════════════════════
// POST /api/process-commissions (internal only)
// ═══════════════════════════════════════════════════════════════

import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import type { DocumentData, QuerySnapshot } from 'firebase-admin/firestore';

// ─── Firebase Admin init (ROBUST) ─────────────────────────────
function parseFirebaseKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let key = raw.trim();
  if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1).trim();
  if (key.includes('-----BEGIN')) return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
  try {
    const decoded = Buffer.from(key, 'base64').toString('utf-8');
    if (decoded.includes('-----BEGIN')) return decoded.includes('\\n') ? decoded.replace(/\\n/g, '\n') : decoded;
  } catch { /* fall through */ }
  return key;
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: parseFirebaseKey(process.env.FIREBASE_PRIVATE_KEY),
    }),
  });
}

const db = admin.firestore();

// ═══════════════════════════════════════════════════════════════
// Plan configuration
// ═══════════════════════════════════════════════════════════════
interface PlanConfig {
  tier: 'bronze' | 'silver' | 'gold';
  maxIndirects: number; 
  directPct: number;
  networkPct: number;
  pricePkr: number;
}

const PLAN_TABLE: Record<string, PlanConfig> = {
  refero_bronze: { tier: 'bronze', maxIndirects: 3, directPct: 20, networkPct: 5, pricePkr: 2000 },
  refero_silver: { tier: 'silver', maxIndirects: 6, directPct: 20, networkPct: 5, pricePkr: 3000 },
  refero_gold:   { tier: 'gold',   maxIndirects: 10, directPct: 20, networkPct: 5, pricePkr: 4000 },
};

// ✅ HARD CAP: We only ever walk 2 levels up (Direct + Indirect)
const MAX_UPLINE_WALK = 2; 

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
// Handler
// ═══════════════════════════════════════════════════════════════
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  // ✅ FIX: Split res.status and return to satisfy Promise<void>
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  
  if (req.headers['x-internal-key'] !== process.env.INTERNAL_API_KEY) {
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
    // ═══════════════════════════════════════════════════════════
    // STEP 1: Atomic Claim (Idempotency & Concurrency Guard)
    // ═══════════════════════════════════════════════════════════
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

    // ═══════════════════════════════════════════════════════════
    // STEP 2: Fetch Trigger User & Validate Data
    // ═══════════════════════════════════════════════════════════
    const triggerUserDoc = await db.collection('users').doc(userId).get();
    if (!triggerUserDoc.exists) {
      res.status(200).json({ status: 'user_not_found' });
      return;
    }
    
    const triggerUser = triggerUserDoc.data()!;
    const triggerName = triggerUser.fullName || 'Someone';
    const buyerReferralIndex = Number(triggerUser.referralIndex) || 0; 

    if (!triggerUser.referredBy) {
      await subRef.update({ commissionsDistributed: 0, commissionsReason: 'no_referrer' });
      res.status(200).json({ status: 'no_referrer' });
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 3: Build Upline Chain (Max 2 Levels)
    // ═══════════════════════════════════════════════════════════
    const chain: UplineNode[] = await buildUplineChain(triggerUser.referredBy);

    if (chain.length === 0) {
      await subRef.update({ commissionsDistributed: 0, commissionsReason: 'no_upline' });
      res.status(200).json({ status: 'no_upline' });
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 4: Compute Credits (with 2-Level & Quantity Caps)
    // ═══════════════════════════════════════════════════════════
    const directAmount = (amount * planConfig.directPct) / 100;
    const networkAmount = (amount * planConfig.networkPct) / 100;
    const credits: CommissionRecipient[] = [];

    for (let i = 0; i < chain.length; i++) {
      const level = i + 1; // 1 = Direct Referrer, 2 = Indirect Referrer
      const recipient = chain[i];

      // Skip free users entirely
      if (recipient.tier === 'free') continue;

      let creditAmount = 0;

      if (level === 1) {
        // Level 1: Direct always gets paid
        creditAmount = directAmount;
      } else if (level === 2) {
        // Level 2: Indirect gets paid ONLY if the quantity cap allows it
        const maxAllowed = getMaxIndirectsForTier(recipient.tier);
        
        if (buyerReferralIndex > maxAllowed) {
          console.log(`⛔ Level 2 blocked: Buyer index (${buyerReferralIndex}) > ${recipient.tier} cap (${maxAllowed}).`);
          continue; 
        }
        creditAmount = networkAmount;
      }

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
      await subRef.update({ commissionsDistributed: 0, commissionsReason: 'no_eligible_recipients' });
      res.status(200).json({ status: 'no_eligible_recipients' });
      return;
    }

    // ═══════════════════════════════════════════════════════════
    // STEP 5: Bulk Write
    // ═══════════════════════════════════════════════════════════
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
        description: credit.type === 'direct'
          ? `Direct commission (${planConfig.directPct}%) from ${triggerName}'s ${planName}`
          : `Indirect commission (${planConfig.networkPct}%) from ${triggerName} (Level 2)`,
        timestamp,
      });

      totalDistributed += credit.amount;
    }

    await bulkWriter.close();

    // ═══════════════════════════════════════════════════════════
    // STEP 6: Finalize
    // ═══════════════════════════════════════════════════════════
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
    return;

  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('[process-commissions] fatal error:', err);

    try {
      await subRef.update({
        commissionsProcessed: false,
        commissionsError: err?.message || 'unknown',
      });
    } catch { /* ignore */ }

    res.status(500).json({ success: false, error: err?.message || 'Commission processing failed' });
    return;
  }
}

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

async function buildUplineChain(firstReferralCode: string): Promise<UplineNode[]> {
  const chain: UplineNode[] = [];
  let currentCode: string | null = firstReferralCode;

  for (let i = 0; i < MAX_UPLINE_WALK; i++) {
    if (!currentCode) break;

    const snap: QuerySnapshot<DocumentData> = await db.collection('users')
      .where('referralCode', '==', currentCode)
      .limit(1)
      .get();

    if (snap.empty) break;

    const doc = snap.docs[0];
    const data = doc.data();

    const isBanned = data.isBanned === true;
    const isInactive = data.isActive === false;
    const isSubActive = data.subscriptionStatus === 'active';
    
    let hasActiveAccess = false;
    if (!isBanned && !isInactive && isSubActive) {
      const endDate = data.subscriptionEndDate?.toDate?.();
      hasActiveAccess = !endDate || endDate > new Date();
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

function getMaxIndirectsForTier(tier: string): number {
  switch (tier.toLowerCase()) {
    case 'bronze': return 3;
    case 'silver': return 6;
    case 'gold': return 10;
    default: return 0;
  }
}

function getPlanDisplayName(productId: string): string {
  const map: Record<string, string> = {
    refero_bronze: 'Bronze Plan',
    refero_silver: 'Silver Plan',
    refero_gold: 'Gold Plan',
  };
  return map[productId] || 'Subscription';
}