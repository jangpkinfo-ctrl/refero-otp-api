import { VercelRequest, VercelResponse } from '@vercel/node';
const { db } = require('../lib/firebase/admin');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { code } = req.query;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ valid: false, message: 'Referral code required' });
    }

    const upperCode = code.toUpperCase();
    console.log('🔍 Searching for referral code:', upperCode);

    const snapshot = await db
      .collection('users')
      .where('referralCode', '==', upperCode)
      // .where('isDeleted', '==', false)   // ✅ Temporarily comment this out
      .limit(1)
      .get();

    console.log('📦 Found documents:', snapshot.size);

    if (snapshot.empty) {
      return res.status(200).json({ valid: false });
    }

    return res.status(200).json({ valid: true });
  } catch (error) {
    console.error('Error validating referral:', error);
    return res.status(500).json({ valid: false, message: 'Server error' });
  }
}
