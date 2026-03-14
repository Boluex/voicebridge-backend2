import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)

const FROM = process.env.EMAIL_FROM      || 'noreply@voicebridge.io'
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'VoiceBridge'
const from = `${FROM_NAME} <${FROM}>`

// ─── Welcome Email ────────────────────────────────────────────────────────────
export async function sendWelcomeEmail(params: {
  to: string
  name: string
}) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[DEV] Welcome email would be sent to ${params.to}`)
    return
  }

  await resend.emails.send({
    from,
    to: params.to,
    subject: `Welcome to VoiceBridge, ${params.name.split(' ')[0]}! 🎙️`,
    html: welcomeHtml(params.name),
  })

  console.log(`[Email] Welcome email sent to ${params.to}`)
}

// ─── Payment Link Email ───────────────────────────────────────────────────────
export async function sendPaymentEmail(params: {
  to: string
  customerName: string
  businessName: string
  amount: number
  items: string
  paymentUrl: string
}) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[DEV] Payment email would be sent to ${params.to}: ${params.paymentUrl}`)
    return
  }

  await resend.emails.send({
    from,
    to: params.to,
    subject: `Your order from ${params.businessName} — Payment Link`,
    html: paymentHtml(params),
  })

  console.log(`[Email] Payment link sent to ${params.to}`)
}

// ─── Order Receipt Email ──────────────────────────────────────────────────────
export async function sendOrderReceiptEmail(params: {
  to: string
  customerName: string
  businessName: string
  amount: number
  items: string
}) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[DEV] Receipt email would be sent to ${params.to}`)
    return
  }

  await resend.emails.send({
    from,
    to: params.to,
    subject: `Receipt: Your order from ${params.businessName} is confirmed!`,
    html: receiptHtml(params),
  })
}

// ─── Business Order Alert Email ───────────────────────────────────────────────
export async function sendBusinessOrderAlertEmail(params: {
  to: string
  businessName: string
  orderId: string
  amount: number
  customerName: string
  customerPhone: string
  deliveryAddress: string
  items: string
}) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`[DEV] Business alert email would be sent to ${params.to}`)
    return
  }

  await resend.emails.send({
    from,
    to: params.to,
    subject: `🎉 New Paid Order - ${params.businessName}`,
    html: businessAlertHtml(params),
  })
}

// ─── HTML Templates ───────────────────────────────────────────────────────────

function welcomeHtml(name: string) {
  const firstName = name.split(' ')[0]
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Welcome to VoiceBridge</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:580px;margin:0 auto;padding:40px 20px;">

    <!-- Logo / Header -->
    <div style="text-align:center;margin-bottom:32px;">
      <div style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:16px;padding:14px 24px;">
        <span style="color:white;font-size:20px;font-weight:700;letter-spacing:-0.5px;">🎙️ VoiceBridge</span>
      </div>
    </div>

    <!-- Main card -->
    <div style="background:#13131a;border:1px solid #1f1f2e;border-radius:20px;padding:40px;margin-bottom:24px;">
      <h1 style="color:#ffffff;font-size:26px;font-weight:700;margin:0 0 8px;">
        Welcome, ${firstName}! 👋
      </h1>
      <p style="color:#6b7280;font-size:15px;margin:0 0 28px;line-height:1.6;">
        You're now part of VoiceBridge — the AI voice receptionist platform built for modern businesses.
      </p>

      <div style="background:#0d0d14;border:1px solid #1a1a2e;border-radius:14px;padding:24px;margin-bottom:28px;">
        <h2 style="color:#a78bfa;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:1px;margin:0 0 16px;">
          What VoiceBridge does for you
        </h2>
        <div style="display:flex;flex-direction:column;gap:14px;">
          ${featureRow('🤖', 'AI Receptionist, 24/7', 'Your AI agent answers every call — takes orders, answers questions, handles payments. No missed calls, no hold music.')}
          ${featureRow('📞', 'Real Phone Number', 'Get a dedicated phone number for your business. Customers call it, your AI handles it.')}
          ${featureRow('💳', 'Built-in Payments', 'Your AI agent collects orders and sends Paystack payment links directly to customers via email.')}
          ${featureRow('🧠', 'Learns Your Business', 'Feed it your menu, FAQs, website, or documents — it knows your business inside out.')}
          ${featureRow('📊', 'Call Logs & Transcripts', 'Every call is logged with a full transcript so you never lose track of what was discussed.')}
        </div>
      </div>

      <a href="${process.env.FRONTEND_URL || 'http://localhost:5173'}/dashboard"
        style="display:block;text-align:center;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;text-decoration:none;padding:14px 28px;border-radius:12px;font-weight:600;font-size:15px;">
        Go to your Dashboard →
      </a>
    </div>

    <!-- Getting started steps -->
    <div style="background:#13131a;border:1px solid #1f1f2e;border-radius:20px;padding:32px;margin-bottom:24px;">
      <h2 style="color:#ffffff;font-size:16px;font-weight:600;margin:0 0 20px;">Get started in 3 steps</h2>
      ${stepRow('1', 'Create your business profile', 'Add your business name, category, location and contact details.')}
      ${stepRow('2', 'Train your AI agent', 'Upload your menu, website URL, or FAQs so the agent knows your business.')}
      ${stepRow('3', 'Go live', 'Subscribe to activate your phone number and start taking calls.')}
    </div>

    <!-- Footer -->
    <div style="text-align:center;">
      <p style="color:#374151;font-size:13px;margin:0;">
        You're receiving this because you signed up for VoiceBridge.<br>
        Questions? Reply to this email — we read every one.
      </p>
    </div>

  </div>
</body>
</html>
`
}

function featureRow(emoji: string, title: string, desc: string) {
  return `
  <div style="display:flex;gap:12px;align-items:flex-start;">
    <div style="font-size:20px;flex-shrink:0;margin-top:2px;">${emoji}</div>
    <div>
      <p style="color:#e5e7eb;font-size:14px;font-weight:600;margin:0 0 3px;">${title}</p>
      <p style="color:#6b7280;font-size:13px;margin:0;line-height:1.5;">${desc}</p>
    </div>
  </div>`
}

function stepRow(num: string, title: string, desc: string) {
  return `
  <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:16px;">
    <div style="width:28px;height:28px;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;">
      <span style="color:white;font-size:13px;font-weight:700;">${num}</span>
    </div>
    <div>
      <p style="color:#e5e7eb;font-size:14px;font-weight:600;margin:0 0 3px;">${title}</p>
      <p style="color:#6b7280;font-size:13px;margin:0;">${desc}</p>
    </div>
  </div>`
}

function paymentHtml(params: {
  customerName: string
  businessName: string
  amount: number
  items: string
  paymentUrl: string
}) {
  const firstName = params.customerName.split(' ')[0]
  const formattedAmount = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(params.amount)

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Your Order Payment</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px;">

    <div style="text-align:center;margin-bottom:28px;">
      <div style="display:inline-block;background:linear-gradient(135deg,#6366f1,#8b5cf6);border-radius:16px;padding:12px 20px;">
        <span style="color:white;font-size:18px;font-weight:700;">🎙️ VoiceBridge</span>
      </div>
    </div>

    <div style="background:#13131a;border:1px solid #1f1f2e;border-radius:20px;padding:36px;">
      <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 6px;">
        Hi ${firstName}, here's your payment link 🧾
      </h1>
      <p style="color:#6b7280;font-size:14px;margin:0 0 28px;">
        Your order from <strong style="color:#a78bfa;">${params.businessName}</strong> is ready for payment.
      </p>

      <!-- Order summary -->
      <div style="background:#0d0d14;border:1px solid #1a1a2e;border-radius:12px;padding:20px;margin-bottom:24px;">
        <p style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px;font-weight:600;">Order Summary</p>
        <p style="color:#e5e7eb;font-size:14px;margin:0 0 12px;line-height:1.6;">${params.items}</p>
        <div style="border-top:1px solid #1f1f2e;padding-top:12px;display:flex;justify-content:space-between;align-items:center;">
          <span style="color:#9ca3af;font-size:14px;">Total</span>
          <span style="color:#a78bfa;font-size:18px;font-weight:700;">${formattedAmount}</span>
        </div>
      </div>

      <!-- CTA -->
      <a href="${params.paymentUrl}"
        style="display:block;text-align:center;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;text-decoration:none;padding:16px 28px;border-radius:12px;font-weight:700;font-size:16px;margin-bottom:16px;">
        Pay Now →
      </a>

      <p style="color:#4b5563;font-size:12px;text-align:center;margin:0;">
        This link expires in 24 hours. Secure payment powered by Paystack.
      </p>
    </div>

    <p style="color:#374151;font-size:12px;text-align:center;margin-top:20px;">
      Order placed via ${params.businessName} AI Receptionist · Powered by VoiceBridge
    </p>

  </div>
</body>
</html>
`
}

function receiptHtml(params: {
  customerName: string
  businessName: string
  amount: number
  items: string
}) {
  const firstName = params.customerName.split(' ')[0]
  const formattedAmount = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(params.amount)

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Payment Receipt</title>
</head>
<body style="margin:0;padding:0;background:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px;">

    <div style="text-align:center;margin-bottom:28px;">
      <div style="display:inline-block;background:linear-gradient(135deg,#10b981,#34d399);border-radius:16px;padding:12px 20px;">
        <span style="color:white;font-size:18px;font-weight:700;">✅ Paid successfully</span>
      </div>
    </div>

    <div style="background:#13131a;border:1px solid #1f1f2e;border-radius:20px;padding:36px;">
      <h1 style="color:#ffffff;font-size:22px;font-weight:700;margin:0 0 6px;">
        Thank you, ${firstName}!
      </h1>
      <p style="color:#6b7280;font-size:14px;margin:0 0 28px;">
        We have received your payment of <strong style="color:#10b981;">${formattedAmount}</strong> for your order from <strong>${params.businessName}</strong>.
      </p>

      <div style="background:#0d0d14;border:1px solid #1a1a2e;border-radius:12px;padding:20px;">
        <p style="color:#6b7280;font-size:12px;text-transform:uppercase;letter-spacing:1px;margin:0 0 12px;font-weight:600;">Items Paid For</p>
        <p style="color:#e5e7eb;font-size:14px;margin:0;line-height:1.6;">${params.items}</p>
      </div>

    </div>
  </div>
</body>
</html>
`
}

function businessAlertHtml(params: {
  businessName: string
  orderId: string
  amount: number
  customerName: string
  customerPhone: string
  deliveryAddress: string
  items: string
}) {
  const formattedAmount = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(params.amount)

  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>New Order</title>
</head>
<body style="margin:0;padding:0;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:40px 20px;">

    <div style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;">
      <h1 style="color:#111827;font-size:20px;font-weight:700;margin:0 0 8px;">
        🎉 New Paid Order - ${formattedAmount}
      </h1>
      <p style="color:#6b7280;font-size:14px;margin:0 0 28px;">
        Great news! The VoiceBridge AI intercepted a call and successfully charged a customer. 
        <br>Order ID: ${params.orderId}
      </p>

      <div style="margin-bottom:24px;">
        <h3 style="color:#374151;font-size:12px;text-transform:uppercase;margin:0 0 10px;">Customer Details</h3>
        <p style="margin:0 0 4px;font-size:14px;"><strong>Name:</strong> ${params.customerName}</p>
        <p style="margin:0 0 4px;font-size:14px;"><strong>Phone:</strong> ${params.customerPhone}</p>
        <p style="margin:0 0 4px;font-size:14px;"><strong>Delivery Address:</strong> ${params.deliveryAddress}</p>
      </div>

      <div>
        <h3 style="color:#374151;font-size:12px;text-transform:uppercase;margin:0 0 10px;">Order Items</h3>
        <div style="background:#f3f4f6;padding:12px;border-radius:8px;font-size:14px;color:#4b5563;">
          ${params.items}
        </div>
      </div>
      
      <p style="color:#9ca3af;font-size:12px;margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px;">
        This payment was securely processed by VoiceBridge Paystack and will be routed to your stored bank account soon.
      </p>
    </div>

  </div>
</body>
</html>
`
}