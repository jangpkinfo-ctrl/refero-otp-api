import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    console.error('❌ BREVO_API_KEY not set in environment variables');
    return res.status(500).json({ error: 'Email service not configured' });
  }

  console.log(`📧 Sending OTP to ${email}: ${otp}`);

  const url = 'https://api.brevo.com/v3/smtp/email';
  const payload = {
    sender: { email: 'noreply@refero.com', name: 'Refero' },
    to: [{ email }],
    subject: 'Your OTP Code',
    htmlContent: `<h1>${otp}</h1><p>Expires in 5 minutes.</p>`,
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
    });
    console.log(`✅ OTP sent to ${email}`);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Brevo API error:', error.response?.data || error.message);
    return res.status(500).json({ 
      error: 'Failed to send OTP email',
      details: error.response?.data || error.message 
    });
  }
}
