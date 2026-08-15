const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function getCredentials() {
  const projectId = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  console.log('🔍 Debug: projectId exists?', !!projectId);
  console.log('🔍 Debug: clientEmail exists?', !!clientEmail);
  console.log('🔍 Debug: privateKey exists?', !!privateKey);

  if (!clientEmail || !privateKey) {
    try {
      const serviceAccountPath = path.join(process.cwd(), 'service-account.json');
      if (fs.existsSync(serviceAccountPath)) {
        const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));
        const { client_email, private_key } = serviceAccount;
        if (client_email && private_key) {
          console.log('✅ Using service-account.json for Firebase Admin');
          return {
            projectId: projectId || serviceAccount.project_id,
            clientEmail: client_email,
            privateKey: private_key,
          };
        }
      }
    } catch (_) {
      // ignore
    }
    throw new Error(
      'Missing Firebase Admin credentials. Set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY environment variables, or place a service-account.json file in the project root.'
    );
  }

  // ✅ SAFETY: Only call replace if privateKey exists and is a string
  const cleanPrivateKey = privateKey ? privateKey.replace(/\\n/g, '\n') : privateKey;

  return {
    projectId,
    clientEmail,
    privateKey: cleanPrivateKey,
  };
}

const credentials = getCredentials();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(credentials),
  });
}

const db = admin.firestore();
const auth = admin.auth();

module.exports = { db, auth };
