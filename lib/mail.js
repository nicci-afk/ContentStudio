// Plain transactional email for studio notifications (lead alerts). Uses the
// same providers as sign-in links: Resend when RESEND_API_KEY is set, else SMTP.

export const mailConfigured = () =>
  !!process.env.RESEND_API_KEY || !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);

export async function sendMail({ to, subject, html, replyTo, from: fromOverride, headers }) {
  const from = fromOverride || process.env.LEAD_FROM || process.env.MAGIC_FROM || 'ContentStudio <onboarding@resend.dev>';
  if (process.env.RESEND_API_KEY) {
    const res = await fetch(process.env.RESEND_API_URL || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({ from, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}), ...(headers ? { headers } : {}) }),
    });
    if (!res.ok) throw new Error(`email send failed: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (!mailConfigured()) throw new Error('no email provider configured');
  const { default: nodemailer } = await import('nodemailer');
  const transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transport.sendMail({ from, to, subject, html, replyTo, headers });
}
