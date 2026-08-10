import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';

// ─── Provider Configuration ───
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
  // ─── MAILTRAP (NEW) ───
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

// ─── Default HTML Template ───
function getDefaultOTPHtml(otp: string, year: number): string {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
      </head>
      <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
        <div style="background-color: #ffffff; padding: 30px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.05);">
          <h2 style="color: #1a1a2e; text-align: center; margin-bottom: 20px;">🔐 Your OTP Code</h2>
          <div style="background: #f0f0ff; padding: 20px; border-radius: 8px; text-align: center; border: 2px dashed #6C63FF;">
            <h1 style="font-size: 48px; letter-spacing: 10px; color: #6C63FF; margin: 0; font-weight: bold;">
              ${otp}
            </h1>
          </div>
          <p style="margin-top: 20px; text-align: center; color: #555;">
            This code expires in <strong>5 minutes</strong>.
          </p>
          <p style="text-align: center; color: #888; font-size: 14px;">
            If you did not request this, please ignore this email.
          </p>
          <hr style="margin-top: 30px; border: 0; border-top: 1px solid #eee;">
          <p style="font-size: 12px; color: #aaa; text-align: center;">
            Refero • ${year} • Built with ❤️
          </p>
        </div>
      </body>
    </html>
  `;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ✅ Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  // ✅ Validate request body
  const { email, otp, htmlContent, provider: requestedProvider } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  // ✅ Validate email format
  if (!email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ error: 'Invalid email format' });
  }

  // ✅ Validate OTP format (6 digits)
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ error: 'OTP must be a 6-digit number' });
  }

  const fromEmail = process.env.FROM_EMAIL || 'noreply@referoglobal.com';
  const fromName = process.env.FROM_NAME || 'Refero';
  const subject = 'Your OTP Code for Refero';
  const year = new Date().getFullYear();

  // Use provided HTML or default template
  const html = htmlContent || getDefaultOTPHtml(otp, year);

  // ─── Get active providers (only those with API keys) ───
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

  // ─── Provider order: requested first, then fallback ───
  let providerList = activeProviders;
  if (requestedProvider && activeProviders.includes(requestedProvider)) {
    providerList = [
      requestedProvider,
      ...activeProviders.filter((p) => p !== requestedProvider),
    ];
  }

  let lastError: any = null;

  // ─── Try each provider in order ───
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
