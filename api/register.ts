import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ─── CORS Headers ───
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', 'https://www.referoglobal.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  try {
    // ─── 0. Load Firebase Admin module ───
    let db, auth, admin;
    try {
      const adminModule = require('../lib/firebase/admin');
      db = adminModule.db;
      auth = adminModule.auth;
      admin = adminModule.admin;
      console.log('✅ Admin module loaded');
    } catch (importError: any) {
      console.error('❌ Import error:', importError);
      return res.status(500).json({
        message: 'Failed to load Firebase Admin',
        error: importError.message,
        stack: importError.stack,
      });
    }

    const { fullName, email, password, referralCode, deviceId, deviceModel } = req.body;
    if (!fullName || !email || !password || !referralCode) {
      return res.status(400).json({ message: 'All required fields are missing' });
    }

    // ─── 1. Verify referral code ───
    let referrerId;
    try {
      const referrerDocRef = db.collection('referral_codes').doc(referralCode.toUpperCase());
      const referrerDocSnap = await referrerDocRef.get();
      if (!referrerDocSnap.exists) {
        return res.status(400).json({ message: 'Invalid referral code' });
      }
      referrerId = referrerDocSnap.data().userId;
      console.log('✅ Referral code verified, referrerId:', referrerId);
    } catch (refError: any) {
      console.error('❌ Referral verification error:', refError);
      return res.status(500).json({ message: 'Referral verification failed', error: refError.message });
    }

    // ─── 2. Get referrer's data ───
    let referrerLevel = 0, referrerRootId = referrerId, referrerDirectCount = 0;
    try {
      const referrerUserDoc = await db.collection('users').doc(referrerId).get();
      if (referrerUserDoc.exists) {
        const data = referrerUserDoc.data();
        referrerLevel = data?.level ?? 0;
        referrerRootId = data?.rootId ?? referrerId;
        referrerDirectCount = data?.totalDirectReferrals ?? 0;
      }
      console.log('✅ Referrer data fetched');
    } catch (refDataError: any) {
      console.error('❌ Referrer data error:', refDataError);
      return res.status(500).json({ message: 'Failed to fetch referrer data', error: refDataError.message });
    }

    // ─── 3. Create Firebase Auth user ───
    let userRecord;
    try {
      userRecord = await auth.createUser({
        email,
        password,
        displayName: fullName,
      });
      console.log('✅ Auth user created:', userRecord.uid);
    } catch (authError: any) {
      console.error('❌ Auth createUser error:', authError);
      return res.status(500).json({
        message: 'Failed to create Firebase Auth user',
        error: authError.message,
        code: authError.code,
      });
    }

    // ─── 4. Generate unique referral code ───
    function generateReferralCode(): string {
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
      let code = '';
      for (let i = 0; i < 8; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      return code;
    }

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

    // ─── 5. Save user to Firestore ───
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
      console.log('✅ User document saved');
    } catch (saveError: any) {
      console.error('❌ Firestore save error:', saveError);
      return res.status(500).json({ message: 'Failed to save user', error: saveError.message });
    }

    // ─── 6. Create referral_codes document ───
    try {
      await db.collection('referral_codes').doc(userReferralCode.toUpperCase()).set({
        userId: userRecord.uid,
        createdAt: now,
      });
      console.log('✅ referral_codes document created');
    } catch (refCodeError: any) {
      console.error('❌ referral_codes error:', refCodeError);
      // Continue anyway – it's not critical for OTP, but we should log it.
    }

    // ─── 7. Update referrer ───
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
      console.log('✅ Referrer updated');
    } catch (updateError: any) {
      console.error('❌ Referrer update error:', updateError);
      // Non-critical, continue.
    }

    // ─── 8. Earnings history placeholder ───
    try {
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
      console.log('✅ EarningsHistory placeholder created');
    } catch (earningsError: any) {
      console.error('❌ EarningsHistory error:', earningsError);
      // Non-critical.
    }

    // ─── 9. OTP ───
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
      console.log(`📧 Sending OTP to ${email} via ${otpApiUrl}/send-otp`);
      
      const otpResponse = await fetch(`${otpApiUrl}/send-otp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otp }),
      });
      const otpResult = await otpResponse.json();
      console.log(`📧 OTP response:`, otpResult);
      if (!otpResult.success) {
        console.warn('⚠️ OTP sending reported failure:', otpResult);
      }
    } catch (otpError: any) {
      console.error('❌ OTP error:', otpError);
      // We still return success because user is created, but log the error.
      // Optionally, you can return an error here.
    }

    return res.status(200).json({ success: true, message: 'User registered' });
  } catch (error: any) {
    console.error('❌ Unhandled registration error:', error);
    return res.status(500).json({
      message: 'Registration failed',
      error: error.message,
      stack: error.stack,
    });
  }
}
