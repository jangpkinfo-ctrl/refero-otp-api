const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

// 1. Read the service account JSON file
const serviceAccountPath = path.join(__dirname, 'service-account.json');
if (!fs.existsSync(serviceAccountPath)) {
  console.error('❌ service-account.json not found. Place it in the project root.');
  process.exit(1);
}
const serviceAccount = JSON.parse(fs.readFileSync(serviceAccountPath, 'utf8'));

// 2. Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

async function migrate() {
  console.log('🚀 Starting migration...');
  try {
    // Read all users
    const usersSnapshot = await db.collection('users').get();
    console.log(`📦 Found ${usersSnapshot.size} users.`);
    let created = 0;
    let skipped = 0;

    for (const userDoc of usersSnapshot.docs) {
      const data = userDoc.data();
      const referralCode = data.referralCode;
      if (referralCode) {
        // Check if already exists
        const existing = await db.collection('referral_codes').doc(referralCode).get();
        if (existing.exists) {
          console.log(`⏭️ Skipping existing: ${referralCode}`);
          skipped++;
          continue;
        }
        // Create document in referral_codes
        await db.collection('referral_codes').doc(referralCode).set({
          userId: userDoc.id,
          createdAt: data.createdAt || admin.firestore.FieldValue.serverTimestamp(),
        });
        console.log(`✅ Created referral code: ${referralCode}`);
        created++;
      }
    }
    console.log(`🎉 Migration complete! Created: ${created}, Skipped: ${skipped}`);
  } catch (error) {
    console.error('❌ Migration error:', error);
  }
}

migrate();