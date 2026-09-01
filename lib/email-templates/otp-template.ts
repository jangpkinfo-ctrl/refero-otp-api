// ─── Professional OTP Email Template ──────────────────────────
export function getProfessionalOTPHtml(otp: string): string {
  const year = new Date().getFullYear();
  // ✅ Update these URLs to your actual values
  const logoUrl = 'https://www.referoglobal.com/logo_with_name.png';
  const websiteUrl = 'https://www.referoglobal.com';
  const termsUrl = 'https://www.referoglobal.com/terms';
  const privacyUrl = 'https://www.referoglobal.com/privacy';

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Your OTP Code – Refero</title>
      </head>
      <body style="margin:0; padding:0; background-color:#f6f6f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, Helvetica, sans-serif;">
        <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f6f6f6; padding:24px 0;">
          <tr>
            <td align="center">
              <!-- ─── Main Container ─── -->
              <table width="600" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:16px; box-shadow:0 4px 24px rgba(0,0,0,0.06); overflow:hidden; max-width:600px; width:100%;">
                
                <!-- ─── Header with Logo ─── -->
                <tr>
                  <td style="background: linear-gradient(135deg, #6C63FF, #5a52d5); padding:28px 30px; text-align:center;">
                    <a href="${websiteUrl}" target="_blank" style="text-decoration:none; display:inline-block;">
                      <img src="${logoUrl}" alt="Refero" style="height:44px; max-width:220px; filter: brightness(0) invert(1);" />
                    </a>
                    <p style="color:rgba(255,255,255,0.8); font-size:13px; margin:6px 0 0 0; letter-spacing:0.3px;">
                      Build your referral network &amp; earn commissions
                    </p>
                  </td>
                </tr>

                <!-- ─── Content ─── -->
                <tr>
                  <td style="padding:32px 30px 24px;">
                    <h2 style="color:#1a1a2e; font-size:22px; font-weight:700; margin:0 0 8px 0;">🔐 Your OTP Code</h2>
                    <p style="color:#555; font-size:15px; line-height:1.7; margin:0 0 22px 0;">
                      Use the 6‑digit code below to verify your email address.
                      This code expires in <strong>5 minutes</strong>.
                    </p>

                    <!-- ─── OTP Box ─── -->
                    <div style="background:#f8f8ff; border:2px dashed #6C63FF; border-radius:12px; padding:28px 16px; text-align:center; margin-bottom:22px;">
                      <span style="font-size:48px; letter-spacing:14px; color:#6C63FF; font-weight:700; font-family: 'Courier New', monospace;">
                        ${otp}
                      </span>
                    </div>

                    <p style="color:#888; font-size:13px; margin:0 0 4px 0;">
                      If you did not request this code, please ignore this email.
                    </p>
                    <p style="color:#aaa; font-size:13px; margin:0;">
                      For security, never share this code with anyone.
                    </p>
                  </td>
                </tr>

                <!-- ─── Footer ─── -->
                <tr>
                  <td style="padding:18px 30px; background-color:#fafafa; border-top:1px solid #eee;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td align="center" style="font-size:12px; color:#888;">
                          <a href="${termsUrl}" style="color:#6C63FF; text-decoration:none; font-weight:500;">Terms</a>
                          &nbsp;|&nbsp;
                          <a href="${privacyUrl}" style="color:#6C63FF; text-decoration:none; font-weight:500;">Privacy</a>
                          &nbsp;|&nbsp;
                          <a href="${websiteUrl}" style="color:#6C63FF; text-decoration:none; font-weight:500;">Refero</a>
                          <br/>
                          <span style="color:#aaa;">&copy; ${year} Refero. All rights reserved.</span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}