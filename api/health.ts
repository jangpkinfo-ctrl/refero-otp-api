import { VercelRequest, VercelResponse } from '@vercel/node';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Check environment variables
  const envStatus = {
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: !!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY,
    BREVO_API_KEY: !!process.env.BREVO_API_KEY,
    RESEND_API_KEY: !!process.env.RESEND_API_KEY,
    MAILTRAP_API_TOKEN: !!process.env.MAILTRAP_API_TOKEN,
    VITE_OTP_API_URL: process.env.VITE_OTP_API_URL || 'not set',
  };

  // Try to load admin module
  let adminStatus = 'not loaded';
  let adminError = null;
  try {
    const adminModule = require('../lib/firebase/admin');
    adminStatus = adminModule.db ? 'loaded' : 'loaded but db missing';
  } catch (e: any) {
    adminError = e.message;
    adminStatus = 'error';
  }

  res.status(200).json({
    status: 'ok',
    environment: envStatus,
    adminModule: {
      status: adminStatus,
      error: adminError,
    },
    timestamp: new Date().toISOString(),
  });
}
