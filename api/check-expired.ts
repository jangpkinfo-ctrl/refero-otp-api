// api/check-expired.ts
// ═══════════════════════════════════════════════════════════════
// GET /api/check-expired (Vercel Cron)
//
// Runs daily at midnight UTC.
//
// Flow:
//   1. Verify cron secret
//   2. Find users with subscriptionEndDate < now && status == active
//   3. Mark them expired + disable canRefer/canEarnTasks
//   4. Forfeit pendingBalance if expired > 90 days
//
// Firestore constraint note:
//   A single query cannot have range filters on multiple fields.
//   PHASE 2 therefore queries on subscriptionExpiredAt only, and
//   filters pendingBalance > 0 in application code.
// ═══════════════════════════════════════════════════════════════

import type { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';

// ═══════════════════════════════════════════════════════════════
// Firebase Admin init (ROBUST)
//
// Handles every common private-key format stored in env vars:
//   A) Raw PEM with literal \n                → convert to newlines
//   B) Raw PEM with real newlines             → use as-is
//   C) Base64-encoded PEM                     → decode, then use
//   D) Value wrapped in surrounding quotes    → strip, then parse
//
// Without this, Firebase Admin throws:
//   error:1E08010C:DECODER routines::unsupported
// ═══════════════════════════════════════════════════════════════
function parseFirebaseKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;

  let key = raw.trim();

  // Strip surrounding quotes if present
  if (key.startsWith('"') && key.endsWith('"')) {
    key = key.slice(1, -1).trim();
  }

  // Case A/B: already a PEM (real newlines OR literal \n)
  if (key.includes('-----BEGIN')) {
    if (key.includes('\\n')) {
      return key.replace(/\\n/g, '\n');
    }
    return key;
  }

  // Case C: base64-encoded PEM → decode
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

  // Fallback: return as-is (SDK will surface its own error)
  return key;
}

if (!admin.apps.length) {
  const firebaseKey = parseFirebaseKey(process.env.FIREBASE_PRIVATE_KEY);

  console.log(
    '[check-expired] FIREBASE key starts:',
    firebaseKey?.substring(0, 30),
  );
  console.log(
    '[check-expired] FIREBASE key length:',
    firebaseKey?.length,
  );
  console.log(
    '[check-expired] FIREBASE client email:',
    process.env.FIREBASE_CLIENT_EMAIL,
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

const FORFEIT_DAYS = 90;

export default async function handler(
  req: VercelRequest,
  res: VercelResponse,
): Promise<void> {
  // ─── Verify cron secret ──────────────────────────────────
  const authHeader = req.headers.authorization || '';
  const expectedSecret = `Bearer ${process.env.CRON_SECRET}`;

  if (authHeader !== expectedSecret) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
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
    //
    // Query uses TWO fields with a range on ONE of them:
    //   subscriptionStatus == 'active'   (equality)
    //   subscriptionEndDate < now         (range)
    //
    // Requires composite index:
    //   users: subscriptionStatus (ASC), subscriptionEndDate (ASC)
    // ═══════════════════════════════════════════════════════
    const expiredQuery = await db
      .collection('users')
      .where('subscriptionStatus', '==', 'active')
      .where(
        'subscriptionEndDate',
        '<',
        admin.firestore.Timestamp.fromDate(now),
      )
      .limit(500)
      .get();

    if (!expiredQuery.empty) {
      const batch = db.batch();

      for (const doc of expiredQuery.docs) {
        const data = doc.data();

        // Skip lifetime users (safety)
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
    //
    // ✅ FIX: Query uses ONLY ONE range filter:
    //     subscriptionExpiredAt < forfeitThreshold
    //   The 'pendingBalance > 0' check is done in code below.
    //
    // Requires single-field index (or auto-created):
    //   users: subscriptionExpiredAt (ASC)
    // ═══════════════════════════════════════════════════════
    const forfeitThreshold = new Date(now);
    forfeitThreshold.setDate(forfeitThreshold.getDate() - FORFEIT_DAYS);

    const forfeitQuery = await db
      .collection('users')
      .where(
        'subscriptionExpiredAt',
        '<',
        admin.firestore.Timestamp.fromDate(forfeitThreshold),
      )
      .limit(500)
      .get();

    if (!forfeitQuery.empty) {
      const batch = db.batch();
      let batchOps = 0;

      for (const doc of forfeitQuery.docs) {
        const data = doc.data();
        const pending = data.pendingBalance || 0;

        // ✅ Filter in code (Firestore can't filter on 2 ranges)
        if (pending <= 0) continue;

        // Extra safety: only forfeit users marked as expired
        if (data.subscriptionStatus !== 'expired') continue;

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
        batchOps += 2; // update + log

        // Firestore batch limit is 500 ops — stay safe
        if (batchOps >= 480) break;
      }

      if (batchOps > 0) {
        await batch.commit();
      }
    }

    res.status(200).json({
      success: true,
      ranAt: now.toISOString(),
      ...result,
    });
  } catch (error: unknown) {
    const err = error as { message?: string };
    console.error('[check-expired] error:', err);

    res.status(500).json({
      success: false,
      error: err?.message || 'Cron failed',
      ...result,
    });
  }
}