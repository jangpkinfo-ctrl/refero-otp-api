// api/verify-purchase.ts
// ═══════════════════════════════════════════════════════════════
// POST /api/verify-purchase
//
// Body: { userId, productId, purchaseToken }
//
// Flow:
//   1. Verify purchase with Google Play Developer API
//   2. Check for duplicate (idempotency)
//   3. Determine plan type (subscription vs one-time) 
//   4. Compute subscription dates
//   5. Update user doc + create subscription doc (atomic)
//   6. Fire-and-forget: trigger commission processing
// ═══════════════════════════════════════════════════════════════

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { google } from 'googleapis';
import * as admin from 'firebase-admin';

// ─── Firebase Admin init (once per cold start) ────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

// ─── Google Play API client ───────────────────────────────────
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'),
  scopes: ['https://www.googleapis.com/auth/androidpublisher'],
});

const androidPublisher = google.androidpublisher({
  version: 'v3',
  auth,
});

const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME || 'com.refero.userapp';

// ─── Plan catalog (must mirror lib/models/plan_model.dart) ────
interface PlanMeta {
  tier: 'bronze' | 'silver' | 'gold';
  networkDepth: number;
  pricePkr: number;
}

const PLAN_CATALOG: Record<string, PlanMeta> = {
  // Subscriptions
  refero_bronze: { tier: 'bronze', networkDepth: 3, pricePkr: 1500 },
  refero_silver: { tier: 'silver', networkDepth: 6, pricePkr: 3000 },
  refero_gold:   { tier: 'gold',   networkDepth: 10, pricePkr: 5000 },
  // Lifetime one-time
  refero_bronze_lifetime: { tier: 'bronze', networkDepth: 3, pricePkr: 45000 },
  refero_silver_lifetime: { tier: 'silver', networkDepth: 6, pricePkr: 90000 },
  refero_gold_lifetime:   { tier: 'gold',   networkDepth: 10, pricePkr: 120000 },
};

// ─── Utilities ────────────────────────────────────────────────
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

function addYears(date: Date, years: number): Date {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() + years);
  return d;
}

// ═══════════════════════════════════════════════════════════════
// Handler
// ═══════════════════════════════════════════════════════════════
export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { userId, productId, purchaseToken } = req.body || {};

  // ─── Validate inputs ──────────────────────────────────────
  if (!userId || !productId || !purchaseToken) {
    res.status(400).json({
      error: 'Missing required fields: userId, productId, purchaseToken',
    });
    return;
  }

  const planMeta = PLAN_CATALOG[productId];
  if (!planMeta) {
    res.status(400).json({ error: `Unknown productId: ${productId}` });
    return;
  }

  const isSubscription = !productId.endsWith('_lifetime');

  try {
    // ─── STEP 1: Idempotency check ──────────────────────────
    const existingQuery = await db
      .collection('subscriptions')
      .where('purchaseToken', '==', purchaseToken)
      .limit(1)
      .get();

    if (!existingQuery.empty) {
      const existing = existingQuery.docs[0];
      res.status(200).json({
        success: true,
        status: 'already_verified',
        subscriptionId: existing.id,
      });
      return;
    }

    // ─── STEP 2: Verify with Google Play ────────────────────
    let expiryTime: Date | null = null;
    let autoRenewing = false;
    let orderId = '';
    let basePlanId: string | null = null;
    let googleStartTime: Date | null = null;

    if (isSubscription) {
      // Subscriptions v2 API
      const response = await androidPublisher.purchases.subscriptionsv2.get({
        packageName: PACKAGE_NAME,
        token: purchaseToken,
      });

      const sub = response.data;

      // Validate state
      if (
        sub.subscriptionState !== 'SUBSCRIPTION_STATE_ACTIVE' &&
        sub.subscriptionState !== 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'
      ) {
        res.status(400).json({
          error: `Subscription not active: ${sub.subscriptionState}`,
        });
        return;
      }

      const lineItem = sub.lineItems?.[0];
      if (!lineItem) {
        res.status(400).json({ error: 'No line items in subscription' });
        return;
      }

      basePlanId = lineItem.offerDetails?.basePlanId || null;
      expiryTime = lineItem.expiryTime ? new Date(lineItem.expiryTime) : null;
      googleStartTime = sub.startTime ? new Date(sub.startTime) : null;
      autoRenewing = lineItem.autoRenewingPlan?.autoRenewEnabled ?? false;

      // ✅ FIX: latestOrderId exists in Google's runtime API but is missing
      //         from the shipped TypeScript types in googleapis@140+.
      //         Narrow cast — safe, one-off.
      orderId =
        (sub as { latestOrderId?: string | null }).latestOrderId || '';
    } else {
      // One-time product API
      const response = await androidPublisher.purchases.products.get({
        packageName: PACKAGE_NAME,
        productId,
        token: purchaseToken,
      });

      const product = response.data;

      if (product.purchaseState !== 0) {
        res.status(400).json({
          error: `Product not purchased. State: ${product.purchaseState}`,
        });
        return;
      }

      orderId = product.orderId || '';
      googleStartTime = product.purchaseTimeMillis
        ? new Date(parseInt(product.purchaseTimeMillis, 10))
        : new Date();
      // Lifetime: no expiry
      expiryTime = null;
    }

    // ─── STEP 3: Compute effective dates ────────────────────
    const now = new Date();
    let subscriptionEndDate: Date | null = expiryTime;
    let planDuration: string;

    if (isSubscription) {
      if (basePlanId === 'monthly') {
        planDuration = 'monthly';
        if (!subscriptionEndDate) subscriptionEndDate = addMonths(now, 1);
      } else if (basePlanId === 'yearly') {
        planDuration = 'yearly';
        if (!subscriptionEndDate) subscriptionEndDate = addYears(now, 1);
      } else {
        planDuration = basePlanId || 'monthly';
      }
    } else {
      planDuration = 'lifetime';
      subscriptionEndDate = null;
    }

    // ─── STEP 4: Atomic Firestore update ────────────────────
    const batch = db.batch();

    const userRef = db.collection('users').doc(userId);
    const subscriptionRef = db.collection('subscriptions').doc();

    batch.update(userRef, {
      tier: planMeta.tier,
      subscriptionStatus: 'active',
      planDuration,
      subscriptionStartDate: googleStartTime || now,
      subscriptionEndDate,
      googlePlayPurchaseToken: purchaseToken,
      googlePlayProductId: productId,
      googlePlayOrderId: orderId,
      googlePlayAutoRenewing: autoRenewing,
      subscriptionExpiredAt: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    batch.set(subscriptionRef, {
      userId,
      productId,
      basePlanId,
      tier: planMeta.tier,
      duration: planDuration,
      amount: planMeta.pricePkr,
      paymentMethod: 'google_play',
      purchaseToken,
      orderId,
      autoRenewing,
      status: 'active',
      startDate: googleStartTime || now,
      endDate: subscriptionEndDate,
      commissionsProcessed: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await batch.commit();

    // ─── STEP 5: Fire commission processing (non-blocking) ──
    // ✅ Response goes out FIRST → no added latency for the client
    // ✅ Vercel keeps the function alive briefly to let fetch complete
    const baseUrl =
      process.env.API_BASE_URL || `https://${req.headers.host}`;

    fetch(`${baseUrl}/api/process-commissions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({
        userId,
        subscriptionId: subscriptionRef.id,
        productId,
        amount: planMeta.pricePkr,
      }),
    }).catch((err) => {
      console.error('[verify-purchase] commission trigger failed:', err);
    });

    res.status(200).json({
      success: true,
      subscriptionId: subscriptionRef.id,
      tier: planMeta.tier,
      duration: planDuration,
      endDate: subscriptionEndDate?.toISOString() || null,
    });
  } catch (error: unknown) {
    console.error('[verify-purchase] error:', error);

    // Google Play API errors surface here
    const err = error as {
      response?: { data?: { error?: { message?: string } } };
      message?: string;
    };

    const message =
      err?.response?.data?.error?.message ||
      err?.message ||
      'Verification failed';

    res.status(500).json({
      success: false,
      error: message,
    });
  }
}
