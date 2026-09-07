import { VercelRequest, VercelResponse } from '@vercel/node';
// ✅ Use Admin SDK (bypasses Firestore rules)
const { db } = require('../lib/firebase/admin');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ─── CORS ──────────────────────────────────────────────────────
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

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ valid: false, message: 'Method not allowed' });
  }

  try {
    const { code } = req.query;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ valid: false, message: 'Referral code required' });
    }

    console.log(`🔍 Validating referral code: ${code.toUpperCase()}`);

    // ✅ Admin SDK – query the referral_codes collection (not users)
    const docRef = db.collection('referral_codes').doc(code.toUpperCase());
    const doc = await docRef.get();

    if (!doc.exists) {
      console.log(`❌ Referral code not found: ${code.toUpperCase()}`);
      return res.status(404).json({ valid: false, message: 'Invalid referral code' });
    }

    const data = doc.data();
    console.log(`✅ Referral code valid, userId: ${data?.userId}`);

    return res.status(200).json({
      valid: true,
      userId: data?.userId,
    });
  } catch (error: any) {
    console.error('❌ Error validating referral:', error);
    return res.status(500).json({
      valid: false,
      message: 'Server error',
      error: error.message,
    });
  }
}
