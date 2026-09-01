import { VercelRequest, VercelResponse } from '@vercel/node';
// ✅ Import Firebase Admin
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { admin, db } = require('../lib/firebase/admin');
import axios from 'axios';
// ✅ Import the professional email template
import { getProfessionalOTPHtml } from '../lib/email-templates/otp-template';

// ─── Provider Configuration ──────────────────────────────────────
const PROVIDERS: Record<string, any> = {
  brevo: {
    name: 'Brevo',
    url: 'https://api.brevo.com/v3/smtp/email',
    apiKey: process.env.BREVO_API_KEY,
    headers: (key: string) => ({ 
      'api-key': key,  
      'Content-Type': 'application/json' 
    }),
    payload: (fromEmail: string, fromName: string, to: string, subject: string, html: string) => ({
      sender: { email: fromEmail, name: fromName },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
    send: async (payload: any, headers: any, url: string) => {
      return await axios.post(url, payload, { headers, timeout: 10000 });
    },
  },
  mailgun: {
    name: 'Mailgun',
    url: (domain: string) => `https://api.mailgun.net/v3/${domain}/messages`,
    apiKey: process.env.MAILGUN_API_KEY,
    domain: process.env.MAILGUN_DOMAIN,
    headers: (key: string) => ({
      Authorization: 'Basic ' + Buffer.from(`api:${key}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    }),
    payload: (fromEmail: string, fromName: string, to: string, subject: string, html: string) => {
      const params = new URLSearchParams({
        from: `${fromName} <${fromEmail}>`,
        to,
        subject,
        html,
      });
      return params.toString();
    },
    send: async (payload: any, headers: any, url: string) => {
      return await axios.post(url, payload, { headers, timeout: 10000 });
    },
  },
  resend: {
    name: 'Resend',
    url: 'https://api.resend.com/emails',
    apiKey: process.env.RESEND_API_KEY,
    headers: (key: string) => ({ 
      Authorization: `Bearer ${key}`, 
      'Content-Type': 'application/json' 
    }),
    payload: (fromEmail: string, fromName: string, to: string, subject: string, html: string) => ({
      from: `${fromName} <${fromEmail}>`,
      to: [to],
      subject,
      html,
    }),
    send: async (payload: any, headers: any, url: string) => {
      return await axios.post(url, payload, { headers, timeout: 10000 });
    },
  },
  mailtrap: {
    name: 'Mailtrap',
    url: 'https://send.api.mailtrap.io/api/send',
    apiKey: process.env.MAILTRAP_API_TOKEN,
    headers: (key: string) => ({
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
    }),
    payload: (fromEmail: string, fromName: string, to: string, subject: string, html: string) => ({
      from: { email: fromEmail, name: fromName },
      to: [{ email: to }],
      subject: subject,
      html: html,
      category: 'OTP Verification',
    }),
    send: async (payload: any, headers: any, url: string) => {
      return await axios.post(url, payload, { headers, timeout: 10000 });
    },
  },
};

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

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // ─── Validate request ─────────────────────────────────────────
  const { email, otp, htmlContent, provider: requestedProvider } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  if (!email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: 'OTP must be a 6-digit number' });
  }

  // ─── Find user by email ──────────────────────────────────────
  let userId: string | null = null;
  try {
    const userSnapshot = await db
      .collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (userSnapshot.empty) {
      console.log(`❌ User not found for email: ${email}`);
      return res.status(404).json({ error: 'User not found' });
    }

    userId = userSnapshot.docs[0].id;
    console.log(`👤 Found user UID: ${userId}`);
  } catch (error) {
    console.error('❌ Error finding user:', error);
    return res.status(500).json({ error: 'Failed to find user' });
  }

  // ─── Store OTP in Firestore ──────────────────────────────────
  try {
    const now = new Date();
    await db
      .collection('users')
      .doc(userId)
      .collection('otp')
      .doc('current')
      .set({
        code: otp,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: new Date(now.getTime() + 5 * 60 * 1000),
        isUsed: false,
      });
    console.log(`✅ OTP stored in Firestore for user ${userId}`);
  } catch (error) {
    console.error('❌ Error storing OTP:', error);
    return res.status(500).json({ error: 'Failed to store OTP' });
  }

  // ─── Send email ──────────────────────────────────────────────
  const fromEmail = process.env.FROM_EMAIL || 'noreply@referoglobal.com';
  const fromName = process.env.FROM_NAME || 'Refero';
  const subject = '🔐 Your OTP Code for Refero';

  // ✅ Use the professional template – allow override via htmlContent
  const html = htmlContent || getProfessionalOTPHtml(otp);

  // ─── Get active providers ─────────────────────────────────────
  const activeProviders = Object.keys(PROVIDERS).filter((key) => {
    const p = PROVIDERS[key];
    return p.apiKey && p.apiKey.length > 0;
  });

  if (activeProviders.length === 0) {
    console.error('❌ No email providers configured');
    return res.status(500).json({ 
      error: 'Email service not configured. Please contact support.' 
    });
  }

  console.log(`📧 Active providers: ${activeProviders.join(', ')}`);

  // ─── Provider order: requested first, then fallback ──────────
  let providerList = activeProviders;
  if (requestedProvider && activeProviders.includes(requestedProvider)) {
    providerList = [
      requestedProvider,
      ...activeProviders.filter((p) => p !== requestedProvider),
    ];
  }

  let lastError: any = null;

  // ─── Try each provider ──────────────────────────────────────
  for (const providerKey of providerList) {
    const provider = PROVIDERS[providerKey];
    
    console.log(`📤 Trying ${provider.name}...`);

    try {
      const url = typeof provider.url === 'function'
        ? provider.url(provider.domain || '')
        : provider.url;

      const payload = provider.payload(fromEmail, fromName, email, subject, html);
      const headers = provider.headers(provider.apiKey);

      const response = await provider.send(payload, headers, url);

      console.log(`✅ OTP sent via ${provider.name} to ${email} (Status: ${response.status})`);
      
      return res.status(200).json({
        success: true,
        message: 'OTP sent successfully',
        provider: provider.name,
      });

    } catch (error: any) {
      console.error(`❌ ${provider.name} error:`, error.response?.data || error.message);
      lastError = error;
      // Continue to next provider
    }
  }

  // ─── All providers failed ───
  console.error('❌ All email providers failed');
  return res.status(500).json({
    error: 'Failed to send OTP email. All providers are temporarily unavailable.',
    details: lastError?.response?.data || lastError?.message || 'Unknown error',
  });
}
