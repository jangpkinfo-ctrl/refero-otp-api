import { VercelRequest, VercelResponse } from '@vercel/node';
const { db, auth } = require('../../lib/firebase/admin');

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
    const { fullName, email, password, referralCode } = req.body;

    if (!fullName || !email || !password || !referralCode) {
      return res.status(400).json({ message: 'All fields are required' });
    }

    // Verify referral code exists
    const referrerSnapshot = await db
      .collection('users')
      .where('referralCode', '==', referralCode.toUpperCase())
      .where('isDeleted', '==', false)
      .limit(1)
      .get();

    if (referrerSnapshot.empty) {
      return res.status(400).json({ message: 'Invalid referral code' });
    }

    const referrerDoc = referrerSnapshot.docs[0];
    const referrerData = referrerDoc.data();

    // Create Firebase Auth user
    const userRecord = await auth.createUser({
      email,
      password,
      displayName: fullName,
    });

    // Generate unique referral code for the new user
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

    const referrerLevel = referrerData['level'] ?? 0;
    const referrerRootId = referrerData['rootId'] ?? referrerDoc.id;
    const level = referrerLevel + 1;

    if (level > 10) {
      await auth.deleteUser(userRecord.uid);
      return res.status(400).json({ message: 'Maximum referral depth (10) reached' });
    }

    // Save user to Firestore
    await db.collection('users').doc(userRecord.uid).set({
      uid: userRecord.uid,
      email,
      fullName,
      referralCode: userReferralCode,
      referredBy: referralCode.toUpperCase(),
      referralLink: `https://referoglobal.com?ref=${userReferralCode}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      deviceId: 'web_registration',
      deviceModel: 'web',
      level,
      rootId: referrerRootId,
      referralIndex: (referrerData['totalDirectReferrals'] ?? 0) + 1,
      isActive: true,
      isDeleted: false,
      isEmailVerified: false,
      tier: 'free',
      subscriptionStatus: 'inactive',
      walletBalance: 0,
      totalEarnings: 0,
      totalDirectReferrals: 0,
      totalNetworkReferrals: 0,
    });

    // Update referrer
    await db
      .collection('users')
      .doc(referrerDoc.id)
      .collection('referralHistory')
      .doc(userRecord.uid)
      .set(
        {
          referredUserId: userRecord.uid,
          referredAt: new Date(),
        },
        { merge: true }
      );

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await db
      .collection('users')
      .doc(userRecord.uid)
      .collection('otp')
      .doc('current')
      .set({
        code: otp,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 5 * 60 * 1000),
        isUsed: false,
      });

    // Send OTP using your existing send-otp logic
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