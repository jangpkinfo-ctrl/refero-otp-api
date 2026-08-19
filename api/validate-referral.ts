import { VercelRequest, VercelResponse } from '@vercel/node';
import { initializeApp, getApps } from 'firebase/app';
import { getFirestore, doc, getDoc } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

let app;
if (getApps().length === 0) {
  app = initializeApp(firebaseConfig);
  console.log('✅ Firebase app initialized');
} else {
  app = getApps()[0];
  console.log('✅ Using existing Firebase app');
}

const db = getFirestore(app);
console.log('✅ Firestore instance obtained');

export default async function handler(req: VercelRequest, res: VercelResponse) {
  console.log('🔵 Function invoked at:', new Date().toISOString());
  console.log('🔵 Request query:', req.query);

  try {
    const { code } = req.query;

    if (!code || typeof code !== 'string') {
      console.warn('⚠️ No code provided or invalid type');
      return res.status(400).json({ valid: false, message: 'Referral code required' });
    }

    const upperCode = code.toUpperCase();
    console.log(`🔍 Querying referral_codes for code: "${upperCode}" (original: "${code}")`);

    // ✅ Query the public referral_codes collection
    const docRef = doc(db, 'referral_codes', upperCode);
    console.log(`📄 Document path: ${docRef.path}`);

    const docSnap = await getDoc(docRef);
    console.log(`📦 Document exists: ${docSnap.exists()}`);

    if (docSnap.exists()) {
      console.log('✅ Document data:', docSnap.data());
    } else {
      console.warn('⚠️ No document found with ID:', upperCode);
    }

    return res.status(200).json({ valid: docSnap.exists() });
  } catch (error: any) {
    console.error('❌ Error validating referral:', error.message);
    console.error('❌ Stack:', error.stack);
    return res.status(500).json({ valid: false, message: 'Server error: ' + error.message });
  }
}
