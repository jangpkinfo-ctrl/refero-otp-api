// api/redeem-promo.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';

// ─── Firebase Admin init (cold-start safe) ────────────────────
if (!admin.apps.length) {
  const parseFirebaseKey = (raw: string | undefined) => {
    if (!raw) return undefined;
    let key = raw.trim();
    if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1).trim();
    if (key.includes('-----BEGIN')) {
      return key.includes('\\n') ? key.replace(/\\n/g, '\n') : key;
    }
    try {
      const decoded = Buffer.from(key, 'base64').toString('utf-8');
      if (decoded.includes('-----BEGIN')) {
        return decoded.includes('\\n') ? decoded.replace(/\\n/g, '\n') : decoded;
      }
    } catch {}
    return key;
  };

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: parseFirebaseKey(process.env.FIREBASE_PRIVATE_KEY),
    }),
  });
}

const db = admin.firestore();

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { userId, code } = req.body || {};

  if (!userId || !code) {
    return res.status(400).json({ error: 'Missing userId or code' });
  }

  try {
    // 1. Find the code (case-insensitive by converting to uppercase)
    const codeQuery = await db.collection('promo_codes')
      .where('code', '==', code.toUpperCase().trim())
      .limit(1)
      .get();

    if (codeQuery.empty) {
      return res.status(404).json({ error: 'Invalid promo code' });
    }

    const codeDoc = codeQuery.docs[0];
    const codeData = codeDoc.data();

    // 2. Validate code status
    if (!codeData.isActive) {
      return res.status(400).json({ error: 'This code is no longer active' });
    }
    if (codeData.usedCount >= codeData.maxUses) {
      return res.status(400).json({ error: 'This code has reached its usage limit' });
    }

    // 3. Check if this specific user already used it
    const usedBy = codeData.usedBy || [];
    if (usedBy.includes(userId)) {
      return res.status(400).json({ error: 'You have already used this code' });
    }

    // 4. Calculate new dates (Default to 365 days if not specified)
    const durationDays = codeData.durationDays || 365;
    const now = new Date();
    const endDate = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    // 5. Atomic update: Update User & Mark code as used
    const batch = db.batch();
    const userRef = db.collection('users').doc(userId);

    batch.update(userRef, {
      tier: codeData.tier,             // bronze, silver, or gold
      subscriptionStatus: 'active',
      planDuration: 'yearly',
      subscriptionStartDate: now,
      subscriptionEndDate: endDate,
      pendingSubscription: null,
      pendingPlanId: null,
      subscriptionExpiredAt: null,     // ✅ CLEAR EXPIRY
      canRefer: true,                  // ✅ UNLOCK REFERRALS
      canEarnTasks: true,              // ✅ UNLOCK TASKS
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.update(codeDoc.ref, {
      usedCount: admin.firestore.FieldValue.increment(1),
      usedBy: admin.firestore.FieldValue.arrayUnion(userId),
    });

    await batch.commit();

    return res.status(200).json({ 
      success: true, 
      tier: codeData.tier,
      message: `Successfully activated ${codeData.tier} plan for 1 year.`
    });

  } catch (error: any) {
    console.error('[redeem-promo] error:', error);
    return res.status(500).json({ error: error.message || 'Failed to redeem code' });
  }
}