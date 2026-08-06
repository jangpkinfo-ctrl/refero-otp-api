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
  console.log(`🔑 API Key length: ${BREVO_API_KEY.length}`);

  const url = 'https://api.brevo.com/v3/smtp/email';
  const payload = {
    sender: { email: 'noreply@refero.com', name: 'Refero' },
    to: [{ email }],
    subject: 'Your OTP Code',
    htmlContent: `
      <html>
        <body>
          <h1 style="color: #6C63FF;">${otp}</h1>
          <p>This code expires in <strong>5 minutes</strong>.</p>
        </body>
      </html>
    `,
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'api-key': BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
    });
    console.log('✅ Brevo response:', response.status, response.data);
    return res.status(200).json({ success: true });
  } catch (error: any) {
    // ✅ Log the FULL Brevo error response
    console.error('❌ Brevo API error details:');
    console.error('Status:', error.response?.status);
    console.error('Data:', JSON.stringify(error.response?.data, null, 2));
    console.error('Message:', error.message);
    
    return res.status(500).json({ 
      error: 'Failed to send OTP email',
      details: error.response?.data || error.message 
    });
  }
}
