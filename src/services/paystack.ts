/**
 * Paystack Payment Service
 * Handles payment link generation and verification
 */

const PAYSTACK_API = 'https://api.paystack.co'

function getHeaders(secretKey?: string) {
  const key = secretKey || process.env.PAYSTACK_SECRET_KEY!
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  }
}

// ─── Create a payment link for an order ───────────────────────────────────────
export async function createPaymentLink(params: {
  amount:      number        // in NGN (kobo = amount * 100)
  email:       string
  reference:   string
  name:        string
  description: string
  metadata:    Record<string, unknown>
  secretKey?:  string
}) {
  const body = {
    amount:      Math.round(params.amount * 100), // convert to kobo
    email:       params.email,
    reference:   params.reference,
    name:        params.name,
    description: params.description,
    currency:    'NGN',
    metadata:    params.metadata,
    callback_url: `${process.env.FRONTEND_URL}/payment/callback`,
  }

  const res = await fetch(`${PAYSTACK_API}/transaction/initialize`, {
    method: 'POST',
    headers: getHeaders(params.secretKey),
    body: JSON.stringify(body),
  })

  const data = await res.json() as {
    status: boolean
    message: string
    data: { authorization_url: string; access_code: string; reference: string }
  }

  if (!data.status) {
    throw new Error(`Paystack error: ${data.message}`)
  }

  return {
    url:       data.data.authorization_url,
    reference: data.data.reference,
    code:      data.data.access_code,
  }
}

// ─── Verify a payment ─────────────────────────────────────────────────────────
export async function verifyPayment(reference: string, secretKey?: string) {
  const res = await fetch(`${PAYSTACK_API}/transaction/verify/${reference}`, {
    headers: getHeaders(secretKey),
  })

  const data = await res.json() as {
    status: boolean
    data: {
      status: string           // 'success' | 'failed' | 'pending'
      amount: number           // kobo
      currency: string
      reference: string
      metadata: Record<string, unknown>
      customer: { email: string }
      paid_at: string
    }
  }

  return {
    success:   data.data.status === 'success',
    status:    data.data.status,
    amount:    data.data.amount / 100,
    reference: data.data.reference,
    paidAt:    data.data.paid_at,
    metadata:  data.data.metadata,
    email:     data.data.customer.email,
  }
}

// ─── Verify webhook signature ─────────────────────────────────────────────────
import crypto from 'crypto'

export function verifyWebhookSignature(payload: Buffer, signature: string): boolean {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET || process.env.PAYSTACK_SECRET_KEY!
  const hash = crypto.createHmac('sha512', secret).update(payload).digest('hex')
  return hash === signature
}

// ─── Automated Payouts (Transfers) ────────────────────────────────────────────

// Helper to map common bank names to Paystack Bank Codes. 
// A real production app would use a searchable dropdown fetched from Paystack.
const NIGERIAN_BANKS: Record<string, string> = {
  'GTBANK': '058',
  'GUARANTY TRUST BANK': '058',
  'FIRST BANK': '011',
  'FIRST BANK OF NIGERIA': '011',
  'ZENITH BANK': '057',
  'UBA': '033',
  'UNITED BANK FOR AFRICA': '033',
  'ACCESS BANK': '044',
  'KUDA': '50211',
  'OPAY': '090399',
  'PALMPAY': '090281',
  'MONIEPOINT': '090405',
}

function resolveBankCode(bankName: string): string {
  const normalized = bankName.toUpperCase().trim()
  return NIGERIAN_BANKS[normalized] || '058' // fallback to GTB if unknown just for this demo scope
}

export async function createTransferRecipient(
  name: string,
  accountNumber: string,
  bankName: string,
  secretKey?: string
) {
  const bankCode = resolveBankCode(bankName)
  
  const body = {
    type: 'nuban',
    name: name,
    account_number: accountNumber,
    bank_code: bankCode,
    currency: 'NGN'
  }

  const res = await fetch(`${PAYSTACK_API}/transferrecipient`, {
    method: 'POST',
    headers: getHeaders(secretKey),
    body: JSON.stringify(body),
  })

  // We explicitly log to see errors from Paystack if bank matching fails
  const data = await res.json() as any

  if (!data.status) {
    throw new Error(`Paystack recipient error: ${data.message}`)
  }

  return data.data.recipient_code as string
}

export async function initiateTransfer(
  amount: number, // in NGN
  recipientCode: string,
  reason: string,
  secretKey?: string
) {
  const body = {
    source: 'balance',
    amount: Math.round(amount * 100), // kobo
    recipient: recipientCode,
    reason: reason,
  }

  const res = await fetch(`${PAYSTACK_API}/transfer`, {
    method: 'POST',
    headers: getHeaders(secretKey),
    body: JSON.stringify(body),
  })

  const data = await res.json() as any

  if (!data.status) {
    throw new Error(`Paystack transfer error: ${data.message}`)
  }

  return data.data.reference as string
}
