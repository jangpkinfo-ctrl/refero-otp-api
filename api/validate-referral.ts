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
} else {
  app = getApps()[0];
}
const db = getFirestore(app);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { code } = req.query;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({
        valid: false,
        message: 'Referral code required',
        debug: { code: code },
      });
    }

    const upperCode = code.toUpperCase();

    // ✅ Query the public referral_codes collection
    const docRef = doc(db, 'referral_codes', upperCode);
    const docSnap = await getDoc(docRef);

    // ✅ Return debug info in the response
    return res.status(200).json({
      valid: docSnap.exists(),
      debug: {
        originalCode: code,
        queriedCode: upperCode,
        documentPath: docRef.path,
        documentExists: docSnap.exists(),
        documentData: docSnap.exists() ? docSnap.data() : null,
      },
    });
  } catch (error: any) {
    return res.status(500).json({
      valid: false,
      message: 'Server error: ' + error.message,
      debug: { error: error.message, stack: error.stack },
    });
  }
}
