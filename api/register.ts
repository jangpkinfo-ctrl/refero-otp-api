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
  // ─── CORS Headers ──────────────────────────────────────────────
  const allowedOrigins = [
    'https://www.referoglobal.com',
    'http://localhost:5173',
    'http://localhost:5174',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:5174',
  ];
  const origin = req.headers.origin || '';
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    res.setHeader('Access-Control-Allow-Origin', 'https://www.referoglobal.com');
  }
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method not allowed' });

  try {
    const { fullName, email, password, referralCode, deviceId, deviceModel } = req.body;

    console.log('📝 Incoming registration body:', { fullName, email, password: '***', referralCode, deviceId, deviceModel });

    // ─── Validate required fields ──────────────────────────────
    if (!fullName || !email || !password) {
      return res.status(400).json({ message: 'Missing required fields: fullName, email, password' });
    }

    // ─── Check if user already exists ──────────────────────────
    const existingUser = await db.collection('users').where('email', '==', email).get();
    if (!existingUser.empty) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    // ─── Handle referral code (optional) ──────────────────────
    let referrerId: string | null = null;
    const referralCodeToUse = referralCode?.trim() || '';
    if (referralCodeToUse) {
      const referrerDoc = await db.collection('referral_codes').doc(referralCodeToUse.toUpperCase()).get();
      if (referrerDoc.exists) {
        referrerId = referrerDoc.data()?.userId;
        console.log(`✅ Referral code ${referralCodeToUse} is valid, referrer ID: ${referrerId}`);
      } else {
        return res.status(400).json({ message: 'Invalid referral code' });
      }
    } else {
      console.log(`ℹ️ No referral code provided – user will be a root user.`);
    }

    // ─── Create Firebase Auth user ─────────────────────────────
    let userRecord;
    try {
      userRecord = await auth.createUser({
        email,
        password,
        displayName: fullName,
      });
      console.log(`✅ Auth user created: ${userRecord.uid}`);
    } catch (authError: any) {
      console.error('❌ Auth error:', authError);
      return res.status(500).json({ step: 'auth_create_user', error: authError.message, code: authError.code });
    }

    // ─── Generate unique referral code ─────────────────────────
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

    // ─── Determine level/rootId ─────────────────────────────────
    let level = 0;
    let rootId: string | null = null;
    let referralIndex = 0;

    if (referrerId) {
      const referrerDoc = await db.collection('users').doc(referrerId).get();
      if (referrerDoc.exists) {
        const referrerData = referrerDoc.data()!;
        level = (referrerData.level ?? 0) + 1;
        rootId = referrerData.rootId || referrerId;
        referralIndex = (referrerData.totalDirectReferrals ?? 0) + 1;
      }
    }

    if (level > 10) {
      await auth.deleteUser(userRecord.uid);
      return res.status(400).json({ message: 'Maximum referral depth (10) reached' });
    }

    const now = new Date();

    // ─── Save user to Firestore ──────────────────────────────────
    const userData = {
      uid: userRecord.uid,
      email,
      fullName,
      phoneNumber: null,
      profileImageUrl: null,
      referralCode: userReferralCode,
      referredBy: referralCodeToUse || null,
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
      rootId: rootId || userRecord.uid,
      referralIndex,
    };

    await db.collection('users').doc(userRecord.uid).set(userData);

    // ─── Create referral code document ──────────────────────────
    await db.collection('referral_codes').doc(userReferralCode.toUpperCase()).set({
      userId: userRecord.uid,
      createdAt: now,
    });

    // ─── Update referrer (if any) ──────────────────────────────
    if (referrerId) {
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
    }

    // ─── Earnings history placeholder ───────────────────────────
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

    // ─── Generate and send OTP ──────────────────────────────────
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

    console.log(`✅ Registration successful for ${email}`);
    return res.status(200).json({ success: true, message: 'User registered' });
  } catch (error: any) {
    console.error('❌ Unhandled error:', error);
    return res.status(500).json({ message: 'Registration failed', error: error.message, stack: error.stack });
  }
}
