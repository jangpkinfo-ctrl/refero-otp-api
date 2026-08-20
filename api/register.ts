import { VercelRequest, VercelResponse } from '@vercel/node';
const { db, auth, admin } = require('../lib/firebase/admin');

function generateReferralCode(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', 'https://www.referoglobal.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  try {
    const { fullName, email, password, referralCode, deviceId, deviceModel } = req.body;

    if (!fullName || !email || !password || !referralCode) {
      return res.status(400).json({ message: 'All required fields are missing' });
    }

    console.log('📥 Register request:', { email, referralCode, passwordLength: password?.length });

    // ─── STEP 1: Verify referral code ───
    let referrerId;
    try {
      const referrerDocRef = db.collection('referral_codes').doc(referralCode.toUpperCase());
      const referrerDocSnap = await referrerDocRef.get();
      if (!referrerDocSnap.exists) {
        return res.status(400).json({ message: 'Invalid referral code' });
      }
      referrerId = referrerDocSnap.data().userId;
    } catch (err: any) {
      return res.status(500).json({ step: 'verify_referral', error: err.message });
    }

    // ─── STEP 2: Get referrer data ───
    let referrerLevel = 0, referrerRootId = referrerId, referrerDirectCount = 0;
    try {
      const referrerUserDoc = await db.collection('users').doc(referrerId).get();
      if (referrerUserDoc.exists) {
        const data = referrerUserDoc.data();
        referrerLevel = data?.level ?? 0;
        referrerRootId = data?.rootId ?? referrerId;
        referrerDirectCount = data?.totalDirectReferrals ?? 0;
      }
    } catch (err: any) {
      return res.status(500).json({ step: 'get_referrer_data', error: err.message });
    }

    // ─── STEP 3: Create Firebase Auth user ───
    let userRecord;
    try {
      userRecord = await auth.createUser({
        email,
        password,
        displayName: fullName,
      });
      console.log('✅ Auth user created:', userRecord.uid);
    } catch (authError: any) {
      console.error('❌ auth.createUser error:', authError);
      return res.status(500).json({
        step: 'auth_create_user',
        error: authError.message,
        code: authError.code,
        fullError: authError,
      });
    }

    // ─── STEP 4: Generate referral code ───
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

    const level = referrerLevel + 1;
    const rootId = referrerRootId;
    const referralIndex = referrerDirectCount + 1;

    if (level > 10) {
      await auth.deleteUser(userRecord.uid);
      return res.status(400).json({ message: 'Maximum referral depth (10) reached' });
    }

    const now = new Date();

    // ─── STEP 5: Save user to Firestore ───
    try {
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
      await db.collection('users').doc(userRecord.uid).set(userData);
    } catch (err: any) {
      return res.status(500).json({ step: 'save_user', error: err.message });
    }

    // ─── STEP 6: Create referral_codes ───
    try {
      await db.collection('referral_codes').doc(userReferralCode.toUpperCase()).set({
        userId: userRecord.uid,
        createdAt: now,
      });
    } catch (err: any) {
      // Non-critical – continue
      console.warn('referral_codes write failed:', err.message);
    }

    // ─── STEP 7: Update referrer ───
    try {
      await db.collection('users').doc(referrerId).update({
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
    } catch (err: any) {
      console.warn('Referrer update failed:', err.message);
    }

    // ─── STEP 8: OTP ───
    try {
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

      const otpApiUrl = process.env.NEXT_PUBLIC_OTP_API_URL || 'https://refero-otp-api.vercel.app/api';
      await fetch(`${otpApiUrl}/send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      });
    } catch (err: any) {
      console.warn('OTP error:', err.message);
    }

    return res.status(200).json({ success: true, message: 'User registered' });
  } catch (error: any) {
    console.error('❌ Unhandled error:', error);
    return res.status(500).json({
      message: 'Registration failed',
      error: error.message,
      stack: error.stack,
    });
  }
}
