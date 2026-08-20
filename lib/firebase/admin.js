const admin = require('firebase-admin');

// ─── Read service account from Base64 environment variable ───
const encodedServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
if (!encodedServiceAccount) {
  throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable');
}

const serviceAccountJson = Buffer.from(encodedServiceAccount, 'base64').toString('utf8');
const serviceAccount = JSON.parse(serviceAccountJson);

// ─── Initialize Admin SDK ───
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { db, auth, admin };
