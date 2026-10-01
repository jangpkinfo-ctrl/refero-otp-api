// api/cron/check-expired.ts
// ═══════════════════════════════════════════════════════════════
// GET /api/cron/check-expired (Vercel Cron)
//
// Runs daily at midnight UTC.
//
// Flow:
//   1. Verify cron secret
//   2. Find users with subscriptionEndDate < now && status == active
//   3. Mark them expired + disable canRefer/canEarnTasks
//   4. Forfeit pendingBalance if expired > 90 days
// ═══════════════════════════════════════════════════════════════

import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';

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

const FORFEIT_DAYS = 90;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ─── Verify cron secret ──────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const expectedSecret = `Bearer ${process.env.CRON_SECRET}`;

  if (authHeader !== expectedSecret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const now = new Date();
  const result = {
    expired: 0,
    forfeited: 0,
    errors: [] as string[],
  };

  try {
    // ═══════════════════════════════════════════════════════
    // PHASE 1: Expire active subscriptions past their end date
    // ═══════════════════════════════════════════════════════
    const expiredQuery = await db
      .collection('users')
      .where('subscriptionStatus', '==', 'active')
      .where('subscriptionEndDate', '<', admin.firestore.Timestamp.fromDate(now))
      .limit(500) // batch cap
      .get();

    if (!expiredQuery.empty) {
      const batch = db.batch();

      for (const doc of expiredQuery.docs) {
        const data = doc.data();

        // Skip lifetime users (should never happen, but safety)
        if (data.planDuration === 'lifetime') continue;

        batch.update(doc.ref, {
          subscriptionStatus: 'expired',
          subscriptionExpiredAt: admin.firestore.FieldValue.serverTimestamp(),
          canRefer: false,
          canEarnTasks: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        result.expired++;
      }

      await batch.commit();
    }

    // ═══════════════════════════════════════════════════════
    // PHASE 2: Forfeit pendingBalance after 90 days
    // ═══════════════════════════════════════════════════════
    const forfeitThreshold = new Date(now);
    forfeitThreshold.setDate(forfeitThreshold.getDate() - FORFEIT_DAYS);

    const forfeitQuery = await db
      .collection('users')
      .where('subscriptionStatus', '==', 'expired')
      .where('subscriptionExpiredAt', '<',
             admin.firestore.Timestamp.fromDate(forfeitThreshold))
      .where('pendingBalance', '>', 0)
      .limit(500)
      .get();

    if (!forfeitQuery.empty) {
      const batch = db.batch();

      for (const doc of forfeitQuery.docs) {
        const pending = doc.data().pendingBalance || 0;

        batch.update(doc.ref, {
          pendingBalance: 0,
          forfeitedBalance: admin.firestore.FieldValue.increment(pending),
          lastForfeitedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Audit log
        const logRef = db.collection('forfeiture_logs').doc();
        batch.set(logRef, {
          userId: doc.id,
          amountForfeited: pending,
          reason: `${FORFEIT_DAYS}_days_without_renewal`,
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });

        result.forfeited++;
      }

      await batch.commit();
    }

    return res.status(200).json({
      success: true,
      ranAt: now.toISOString(),
      ...result,
    });
  } catch (error: any) {
    console.error('[cron/check-expired] error:', error);
    return res.status(500).json({
      success: false,
      error: error?.message || 'Cron failed',
      ...result,
    });
  }
}
