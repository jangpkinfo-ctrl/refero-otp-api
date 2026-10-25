import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';
import * as admin from 'firebase-admin';

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

// ─── Google Play API client ───────────────────────────────────
const serviceAccountJson = (() => {
  const raw = (process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return {};
  let parsed: Record<string, any> | null = null;
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf-8');
    parsed = JSON.parse(decoded);
  } catch { 
    try { parsed = JSON.parse(raw); } catch { return {}; }
  }
  if (!parsed) return {};
  if (typeof parsed.private_key === 'string') parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  return parsed;
})();

const auth = new google.auth.GoogleAuth({
  credentials: serviceAccountJson,
  scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});

const androidPublisher = google.androidpublisher({ version: 'v3', auth });
const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME || 'com.refero.userapp';

// ─── Plan catalog ─────────────────────────────────────────────
interface PlanMeta {
  tier: 'bronze' | 'silver' | 'gold';
  networkDepth: number;
  pricePkr: number;
}

const PLAN_CATALOG: Record<string, PlanMeta> = {
  refero_bronze: { tier: 'bronze', networkDepth: 3, pricePkr: 2000 },
  refero_silver: { tier: 'silver', networkDepth: 6, pricePkr: 3000 },
  refero_gold:   { tier: 'gold',   networkDepth: 10, pricePkr: 4000 },
};

function addYears(date: Date, years: number): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

// ═══════════════════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════════════════
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { userId, productId, purchaseToken } = req.body || {};
  const uid = String(userId);

  if (!uid || uid === 'undefined' || !productId || !purchaseToken) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const planMeta = PLAN_CATALOG[productId];
  if (!planMeta) {
    res.status(400).json({ error: `Unknown productId: ${productId}` });
    return;
  }

  try {
    // 1. Idempotency Check
    const existingQuery = await db.collection('subscriptions').where('purchaseToken', '==', purchaseToken).limit(1).get();
    if (!existingQuery.empty) {
      res.status(200).json({ success: true, status: 'already_verified', subscriptionId: existingQuery.docs[0].id });
      return;
    }

    // 2. Check if this is a RENEWAL
    const previousSubs = await db.collection('subscriptions').where('userId', '==', uid).limit(1).get();
    const isFirstPurchase = previousSubs.empty;

    // 3. Verify with Google Play
    const response = await androidPublisher.purchases.subscriptionsv2.get({
      packageName: PACKAGE_NAME,
      token: purchaseToken,
    });

    const sub = response.data;
    if (sub.subscriptionState !== 'SUBSCRIPTION_STATE_ACTIVE' && sub.subscriptionState !== 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') {
      res.status(400).json({ error: `Subscription not active: ${sub.subscriptionState}` });
      return;
    }

    const lineItem = sub.lineItems?.[0];
    if (!lineItem) {
      res.status(400).json({ error: 'No line items in subscription' });
      return;
    }

    const expiryTime = lineItem.expiryTime ? new Date(lineItem.expiryTime) : addYears(new Date(), 1);
    const googleStartTime = sub.startTime ? new Date(sub.startTime) : new Date();
    const orderId = (sub as any).latestOrderId || '';
    const autoRenewing = lineItem.autoRenewingPlan?.autoRenewEnabled ?? false;

    // 4. Check for Frozen Funds to Unlock
    const userRef = db.collection('users').doc(uid);
    const subscriptionRef = db.collection('subscriptions').doc();
    
    const userDoc = await userRef.get();
    const currentPending = userDoc.data()?.pendingBalance || 0;

    // 5. Atomic Firestore Update
    const batch = db.batch();

    const userUpdate: any = {
      tier: planMeta.tier,
      subscriptionStatus: 'active',
      planDuration: 'yearly',
      subscriptionStartDate: googleStartTime,
      subscriptionEndDate: expiryTime,
      googlePlayPurchaseToken: purchaseToken,
      googlePlayProductId: productId,
      googlePlayOrderId: orderId,
      googlePlayAutoRenewing: autoRenewing,
      subscriptionExpiredAt: null,
      pendingSubscription: null,
      pendingPlanId: null,
      canRefer: true,
      canEarnTasks: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    // ✅ MOVE FROZEN FUNDS TO WALLET ON RENEWAL
    if (currentPending > 0) {
      userUpdate.walletBalance = admin.firestore.FieldValue.increment(currentPending);
      userUpdate.pendingBalance = 0; // Clear pending balance
      
      // Log the unlock
      const historyRef = userRef.collection('earningsHistory').doc();
      batch.set(historyRef, {
        type: 'unlock',
        amount: currentPending,
        description: 'Unlocked frozen commissions on renewal',
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    batch.update(userRef, userUpdate);

    batch.set(subscriptionRef, {
      userId: uid,
      productId,
      tier: planMeta.tier,
      amount: planMeta.pricePkr,
      paymentMethod: 'google_play',
      purchaseToken,
      orderId,
      autoRenewing,
      status: 'active',
      startDate: googleStartTime,
      endDate: expiryTime,
      commissionsProcessed: !isFirstPurchase, 
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    // 6. Trigger Commissions ONLY on first purchase
    if (isFirstPurchase) {
      console.log(`[verify-purchase] First purchase. Triggering commissions.`);
      const baseUrl = process.env.API_BASE_URL || `https://${req.headers.host}`;
      fetch(`${baseUrl}/api/process-commissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
        body: JSON.stringify({ userId: uid, subscriptionId: subscriptionRef.id, productId, amount: planMeta.pricePkr }),
      }).catch((err) => console.error('[verify-purchase] commission trigger failed:', err));
    } else {
      console.log(`[verify-purchase] Renewal detected. Skipping commissions.`);
    }

    res.status(200).json({
      success: true,
      subscriptionId: subscriptionRef.id,
      tier: planMeta.tier,
      endDate: expiryTime.toISOString(),
    });
  } catch (error: any) {
    console.error('[verify-purchase] error:', error);
    res.status(500).json({ success: false, error: error?.message || 'Verification failed' });
  }
}