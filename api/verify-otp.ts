import { VercelRequest, VercelResponse } from '@vercel/node';
// ✅ Import both admin and db (admin needed for serverTimestamp)
const { admin, db } = require('../lib/firebase/admin');

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

  // ✅ Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ─── Only allow POST ────────────────────────────────────────────
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  // ✅ Ensure request body exists
  if (!req.body) {
    console.error('❌ Request body is missing');
    return res.status(400).json({ message: 'Request body is missing' });
  }

  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    // Basic format validation
    if (!/^\d{6}$/.test(otp)) {
      return res.status(400).json({ message: 'OTP must be a 6-digit number' });
    }

    console.log(`🔍 Verifying OTP for ${email}`);

    // ─── Find user by email ──────────────────────────────────────
    const userSnapshot = await db
      .collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (userSnapshot.empty) {
      console.log(`❌ User not found: ${email}`);
      return res.status(404).json({ message: 'User not found' });
    }

    const userDoc = userSnapshot.docs[0];
    const userId = userDoc.id;
    console.log(`👤 Found user UID: ${userId}`);

    // ─── Get current OTP document ────────────────────────────────
    const otpDoc = await db
      .collection('users')
      .doc(userId)
      .collection('otp')
      .doc('current')
      .get();

    if (!otpDoc.exists) {
      console.log(`❌ No OTP found for user ${userId}`);
      return res.status(400).json({ message: 'OTP not found. Please request a new one.' });
    }

    const otpData = otpDoc.data();

    // ─── Check if OTP is already used ────────────────────────────
    if (otpData?.isUsed) {
      console.log(`❌ OTP already used for user ${userId}`);
      return res.status(400).json({ message: 'OTP already used. Please request a new one.' });
    }

    // ─── Check if OTP has expired ────────────────────────────────
    const expiresAt = otpData?.expiresAt?.toDate?.() || new Date(0);
    if (Date.now() > expiresAt.getTime()) {
      console.log(`❌ OTP expired for user ${userId}`);
      return res.status(400).json({ message: 'OTP expired. Please request a new one.' });
    }

    // ─── Verify the OTP code ──────────────────────────────────────
    if (otpData?.code !== otp) {
      console.log(`❌ Invalid OTP for user ${userId}`);
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    // ─── Mark OTP as used ────────────────────────────────────────
    await db
      .collection('users')
      .doc(userId)
      .collection('otp')
      .doc('current')
      .update({
        isUsed: true,
        verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // ─── Update user's email verification status ─────────────────
    await db
      .collection('users')
      .doc(userId)
      .update({
        isEmailVerified: true,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    console.log(`✅ Email verified for user ${userId}`);
    return res.status(200).json({
      success: true,
      message: 'Email verified successfully',
    });
  } catch (error: any) {
    console.error('❌ OTP verification error:', error);
    return res.status(500).json({
      message: 'Server error',
      details: error.message,
    });
  }
}
