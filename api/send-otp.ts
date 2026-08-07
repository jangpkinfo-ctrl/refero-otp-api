import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';

/**
 * OTP Email Sender – Brevo API
 * Sends a 6-digit OTP code to the user's email address.
 * 
 * Endpoint: POST /api/send-otp
 * Request body: { email: string, otp: string }
 * Response: { success: true } or { error: string, details?: any }
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // ✅ Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ 
      error: 'Method not allowed. Use POST.' 
    });
  }

  // ✅ Validate request body
  const { email, otp } = req.body;
  
  if (!email || !otp) {
    return res.status(400).json({ 
      error: 'Email and OTP are required' 
    });
  }

  // ✅ Validate email format (basic check)
  if (!email.includes('@') || !email.includes('.')) {
    return res.status(400).json({ 
      error: 'Invalid email format' 
    });
  }

  // ✅ Validate OTP format (6 digits)
  if (!/^\d{6}$/.test(otp)) {
    return res.status(400).json({ 
      error: 'OTP must be a 6-digit number' 
    });
  }

  // ✅ Get API key from environment variables
  const BREVO_API_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_API_KEY) {
    console.error('❌ BREVO_API_KEY not set in environment variables');
    return res.status(500).json({ 
      error: 'Email service not configured. Please contact support.' 
    });
  }

  // ✅ Log request (OTP is logged for debugging – remove in production)
  console.log(`📧 Sending OTP to ${email}: ${otp}`);
  console.log(`🔑 API Key length: ${BREVO_API_KEY.length}`);
  console.log(`📅 Time: ${new Date().toISOString()}`);

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
              Refero • ${new Date().getFullYear()} • Built with ❤️
            </p>
          </div>
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
        'Accept': 'application/json',
      },
      timeout: 10000, // 10 seconds timeout
    });

    console.log(`✅ OTP email sent to ${email} (Status: ${response.status})`);
    
    return res.status(200).json({ 
      success: true,
      message: 'OTP sent successfully' 
    });

  } catch (error: any) {
    // ✅ Detailed error logging for debugging
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
