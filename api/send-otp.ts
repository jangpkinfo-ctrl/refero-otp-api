import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ✅ Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ✅ Validate request body
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  // ✅ Get API key from environment variables
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    console.error('❌ BREVO_API_KEY not set in environment variables');
    return res.status(500).json({ error: 'Email service not configured' });
  }

  // ✅ Log for debugging (OTP is logged for development – remove in production)
  console.log(`📧 Sending OTP to ${email}: ${otp}`);
  console.log(`🔑 API Key length: ${BREVO_API_KEY.length}`);

  // ✅ Brevo API endpoint
  const url = 'https://api.brevo.com/v3/smtp/email';

  // ✅ Payload with your authenticated domain
  const payload = {
    sender: { 
      email: 'noreply@referoglobal.com',  // ✅ Your authenticated domain
      name: 'Refero' 
    },
    to: [{ email }],
    subject: 'Your OTP Code for Refero',
    htmlContent: `
      <html>
        <body style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #1a1a2e;">Your OTP Code</h2>
          <div style="background: #f5f5f5; padding: 20px; border-radius: 8px; text-align: center;">
            <h1 style="font-size: 42px; letter-spacing: 8px; color: #6C63FF; margin: 0;">
              ${otp}
            </h1>
          </div>
          <p style="margin-top: 16px;">This code expires in <strong>5 minutes</strong>.</p>
          <p>If you did not request this, please ignore this email.</p>
          <hr style="margin-top: 24px; border: 0; border-top: 1px solid #eee;">
          <p style="font-size: 12px; color: #888;">Refero • ${new Date().getFullYear()}</p>
        </body>
      </html>
    `,
  };

  try {
    // ✅ Send email via Brevo API
    const response = await axios.post(url, payload, {
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      timeout: 10000, // 10 seconds timeout
    });

    console.log(`✅ OTP email sent to ${email} (${response.status})`);
    return res.status(200).json({ success: true });

  } catch (error: any) {
    // ✅ Detailed error logging
    console.error('❌ Brevo API error details:');
    console.error('Status:', error.response?.status);
    console.error('Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Message:', error.message);
    
    // ✅ Return a user-friendly error
    return res.status(500).json({ 
      error: 'Failed to send OTP email. Please try again.',
      details: error.response?.data || error.message 
    });
  }
}
