import { VercelRequest, VercelResponse } from '@vercel/node';
// ✅ Import both admin and db from Admin SDK
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

  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    console.log(`📤 Resending OTP for: ${email}`);

    // ─── Find user by email ──────────────────────────────────────
    const userSnapshot = await db
      .collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (userSnapshot.empty) {
      console.log(`❌ User not found for email: ${email}`);
      return res.status(404).json({ message: 'User not found' });
    }

    const userId = userSnapshot.docs[0].id;
    console.log(`👤 Found user UID: ${userId}`);

    // ─── Generate new OTP ────────────────────────────────────────
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const now = new Date();

    // ─── Store new OTP in Firestore ──────────────────────────────
    await db
      .collection('users')
      .doc(userId)
      .collection('otp')
      .doc('current')
      .set({
        code: otp,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: new Date(now.getTime() + 5 * 60 * 1000), // 5 minutes
        isUsed: false,
      });

    console.log(`✅ OTP stored for user ${userId}`);

    // ─── Send OTP email using send-otp endpoint ──────────────────
    const otpApiUrl = process.env.NEXT_PUBLIC_OTP_API_URL || 'https://refero-otp-api.vercel.app/api';
    const response = await fetch(`${otpApiUrl}/send-otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, otp }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      console.error('❌ OTP send failed:', errorData);
      return res.status(500).json({ 
        message: 'Failed to send OTP email',
        details: errorData 
      });
    }

    console.log(`✅ OTP resent to ${email}`);
    return res.status(200).json({ 
      success: true, 
      message: 'OTP resent successfully' 
    });
  } catch (error: any) {
    console.error('❌ Retransmit OTP error:', error);
    return res.status(500).json({ 
      message: 'Server error', 
      details: error.message 
    });
  }
}
