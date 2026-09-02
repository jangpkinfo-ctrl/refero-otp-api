const admin = require('firebase-admin');

// ─── Get credentials from Base64 environment variable ──────────
const encodedServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

let serviceAccount;
 
if (encodedServiceAccount) {
  // ✅ Decode Base64 → JSON
  const serviceAccountJson = Buffer.from(encodedServiceAccount, 'base64').toString('utf8');
  const raw = JSON.parse(serviceAccountJson);
  // ✅ Normalize property names (snake_case → camelCase)
  serviceAccount = {
    projectId: raw.project_id || raw.projectId,
    clientEmail: raw.client_email || raw.clientEmail,
    privateKey: raw.private_key || raw.privateKey,
  };
  console.log('✅ Firebase Admin initialized from Base64 env var');
} else {
  // ─── Fallback: use individual environment variables ────────────
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Missing Firebase Admin credentials. Set FIREBASE_SERVICE_ACCOUNT_BASE64, ' +
      'or set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.'
    );
  }

  serviceAccount = {
    projectId,
    clientEmail,
    privateKey: privateKey.replace(/\\n/g, '\n'), // ✅ Clean newlines
  };
}

// ─── Initialize Admin SDK ──────────────────────────────────────
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { db, auth };
