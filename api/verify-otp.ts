import { VercelRequest, VercelResponse } from '@vercel/node';
const { db } = require('../lib/firebase/admin');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ─── CORS Headers ───
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', 'https://www.referoglobal.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  try {
    const { email, otp } = req.body;

    if (!email || !otp) {
      return res.status(400).json({ message: 'Email and OTP are required' });
    }

    // Find user by email
    const userSnapshot = await db
      .collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (userSnapshot.empty) {
      return res.status(404).json({ message: 'User not found' });
    }

    const userDoc = userSnapshot.docs[0];
    const userId = userDoc.id;

    // Get OTP
    const otpDoc = await db
      .collection('users')
      .doc(userId)
      .collection('otp')
      .doc('current')
      .get();

    if (!otpDoc.exists) {
      return res.status(400).json({ message: 'OTP not found' });
    }

    const otpData = otpDoc.data();
    const storedOtp = otpData?.code;
    const expiresAt = otpData?.expiresAt?.toDate?.() || new Date(0);
    const isUsed = otpData?.isUsed ?? false;

    if (isUsed || new Date() > expiresAt) {
      return res.status(400).json({ message: 'OTP expired or already used' });
    }

    if (storedOtp !== otp) {
      return res.status(400).json({ message: 'Invalid OTP' });
    }

    // Mark OTP as used and verify email
    await db
      .collection('users')
      .doc(userId)
      .collection('otp')
      .doc('current')
      .update({ isUsed: true });

    await db
      .collection('users')
      .doc(userId)
      .update({
        isEmailVerified: true,
        updatedAt: new Date(),
      });

    return res.status(200).json({ success: true, message: 'Email verified' });
  } catch (error) {
    console.error('OTP verification error:', error);
    return res.status(500).json({ message: 'Server error' });
  }
}
