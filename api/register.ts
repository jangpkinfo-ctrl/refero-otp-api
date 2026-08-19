import { VercelRequest, VercelResponse } from '@vercel/node';
const { db, auth } = require('../lib/firebase/admin');

function generateReferralCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    // Accept deviceId and deviceModel (optional)
    const { fullName, email, password, referralCode, deviceId, deviceModel } = req.body;

    if (!fullName || !email || !password || !referralCode) {
      return res.status(400).json({ message: 'All required fields are missing' });
    }

    // 1. Verify the provided referral code exists in the public collection
    const referrerDocRef = db.collection('referral_codes').doc(referralCode.toUpperCase());
    const referrerDocSnap = await referrerDocRef.get();
    if (!referrerDocSnap.exists) {
      return res.status(400).json({ message: 'Invalid referral code' });
    }
    const referrerData = referrerDocSnap.data();
    const referrerId = referrerData.userId;

    // 2. Get the referrer's full user data to compute level, rootId, etc.
    const referrerUserDoc = await db.collection('users').doc(referrerId).get();
    if (!referrerUserDoc.exists) {
      // Fallback: if referrer not found, treat as root
    }
    const referrerUserData = referrerUserDoc.data() || {};
    const referrerLevel = referrerUserData.level ?? 0;
    const referrerRootId = referrerUserData.rootId ?? referrerId;
    const referrerDirectCount = referrerUserData.totalDirectReferrals ?? 0;

    // 3. Create Firebase Auth user
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: fullName,
    });

    // 4. Generate unique referral code for the new user
    let userReferralCode = generateReferralCode();
    let codeExists = true;
    let attempts = 0;
    while (codeExists && attempts < 10) {
      const check = await db.collection('users').doc(userReferralCode).get();
      if (!check.exists) {
        codeExists = false;
      } else {
        userReferralCode = generateReferralCode();
        attempts++;
      }
    }

    // 5. Compute tree values
    const level = referrerLevel + 1;
    const rootId = referrerRootId;
    const referralIndex = referrerDirectCount + 1;

    // 6. Depth check (max 10)
    if (level > 10) {
      await auth.deleteUser(userRecord.uid);
      return res.status(400).json({ message: 'Maximum referral depth (10) reached' });
    }

    // 7. Build user document (matching app's UserModel)
    const now = new Date();
    const userData = {
      uid: userRecord.uid,
      email,
      fullName,
      phoneNumber: null,
      profileImageUrl: null,
      referralCode: userReferralCode,
      referredBy: referralCode.toUpperCase(),
      referralLink: `https://referoglobal.com?ref=${userReferralCode}`,
      tier: 'free',
      subscriptionStatus: 'inactive',
      pendingSubscription: null,
      pendingPlanId: null,
      walletBalance: 0,
      totalEarnings: 0,
      totalDirectReferrals: 0,
      totalNetworkReferrals: 0,
      paymentMethods: [],
      deviceId: deviceId || 'web_registration',
      deviceModel: deviceModel || 'web',
      isEmailVerified: false,
      isActive: true,
      isBanned: false,
      createdAt: now,
      updatedAt: now,
      lastLoginAt: null,
      fcmToken: null,
      rejectionReason: null,
      rejectedAt: null,
      level,
      rootId,
      referralIndex,
    };

    // 8. Save user to Firestore
    await db.collection('users').doc(userRecord.uid).set(userData);

    // 9. Create public referral code document (with uppercase ID)
    await db.collection('referral_codes').doc(userReferralCode.toUpperCase()).set({
      userId: userRecord.uid,
      createdAt: now,
    });

    // 10. Update referrer's totalDirectReferrals and add referral history
    await db
      .collection('users')
      .doc(referrerId)
      .update({
        totalDirectReferrals: admin.firestore.FieldValue.increment(1),
        updatedAt: now,
      });
    await db
      .collection('users')
      .doc(referrerId)
      .collection('referralHistory')
      .doc(userRecord.uid)
      .set({
        referredUserId: userRecord.uid,
        referredAt: now,
      }, { merge: true });

    // 11. Create placeholder document in earningsHistory (matching app's structure)
    //    This ensures the subcollection exists and can be queried later.
    await db
      .collection('users')
      .doc(userRecord.uid)
      .collection('earningsHistory')
      .doc('_init')
      .set({
        type: 'system',
        amount: 0,
        description: 'Welcome to Refero!',
        timestamp: now,
      });

    // 12. Generate and store OTP (same as before)
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await db
      .collection('users')
      .doc(userRecord.uid)
      .collection('otp')
      .doc('current')
      .set({
        code: otp,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        isUsed: false,
      });

    // 13. Send OTP via your email service
    const otpApiUrl = process.env.NEXT_PUBLIC_OTP_API_URL || 'https://refero-otp-api.vercel.app/api';
    await fetch(`${otpApiUrl}/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp }),
    });

    return res.status(200).json({ success: true, message: 'User registered' });
  } catch (error: any) {
    console.error('Registration error:', error);
    return res.status(500).json({ message: error.message || 'Registration failed' });
  }
}
