/**
 * Public Tool Endpoints
 * Called by ElevenLabs agents during live calls via webhook tool calling.
 * These MUST respond in under 1.5 seconds to maintain natural conversation flow.
 */

import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma.js'
import { createPaymentLink } from '../services/paystack.js'
import { v4 as uuid } from 'uuid'
import nodemailer from 'nodemailer'

const router = Router()

// Simple shared secret to verify requests are from ElevenLabs
function verifyAgentSecret(req: Request, res: Response): boolean {
  const secret = req.headers['x-agent-secret']
  if (secret !== (process.env.AGENT_WEBHOOK_SECRET || 'vb-secret')) {
    res.status(403).json({ error: 'Forbidden' })
    return false
  }
  return true
}

// ─── Tool: lookup_catalogue ───────────────────────────────────────────────────
router.post('/catalogue-lookup', async (req: Request, res: Response) => {
  if (!verifyAgentSecret(req, res)) return

  try {
    const { query, businessId } = req.body as { query: string; businessId: string }

    // Search catalogue items
    const items = await prisma.catalogItem.findMany({
      where: {
        businessId,
        available: true,
        OR: [
          { name:        { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          { category:    { contains: query, mode: 'insensitive' } },
        ],
      },
      take: 5,
    })

    // Also search knowledge sources for broader queries
    const knowledgeMatch = await prisma.knowledgeSource.findFirst({
      where: {
        businessId,
        status: 'INDEXED',
        content: { contains: query, mode: 'insensitive' },
      },
    })

    if (items.length === 0 && !knowledgeMatch) {
      res.json({
        found: false,
        message: `I don't have "${query}" in our catalogue. Let me check if we have alternatives.`,
        items: [],
      })
      return
    }

    const formatted = items.map(i => ({
      name:      i.name,
      price:     `₦${i.price.toLocaleString()}`,
      inStock:   i.inStock,
      available: i.available,
    }))

    res.json({
      found:   true,
      items:   formatted,
      summary: items.length > 0
        ? `Found ${items.length} item(s): ${items.map(i => `${i.name} at ₦${i.price.toLocaleString()}`).join(', ')}`
        : `Found relevant information in knowledge base.`,
      knowledgeContext: knowledgeMatch?.content?.slice(0, 500) || null,
    })
  } catch (err) {
    console.error('[catalogue-lookup]', err)
    res.json({ found: false, message: 'Could not search catalogue right now.' })
  }
})

// ─── Tool: create_order ───────────────────────────────────────────────────────
router.post('/create-order', async (req: Request, res: Response) => {
  if (!verifyAgentSecret(req, res)) return

  try {
    const {
      businessId, customerName, customerEmail, customerPhone,
      deliveryAddress, items, callId,
    } = req.body as {
      businessId:      string
      customerName:    string
      customerEmail?:  string
      customerPhone?:  string
      deliveryAddress?: string
      items:           Array<{ name: string; qty: number; price: number }>
      callId?:         string
    }

    const subtotal = items.reduce((sum, i) => sum + (i.price * i.qty), 0)

    const order = await prisma.order.create({
      data: {
        businessId,
        callId:         callId || null,
        customerName,
        customerEmail:  customerEmail || null,
        customerPhone:  customerPhone || null,
        deliveryAddress: deliveryAddress || null,
        items,
        subtotal,
        status: 'PENDING_PAYMENT',
      },
    })

    res.json({
      success:  true,
      orderId:  order.id,
      subtotal: `₦${subtotal.toLocaleString()}`,
      message:  `Order created. Total is ₦${subtotal.toLocaleString()}. I'll send a payment link now.`,
    })
  } catch (err) {
    console.error('[create-order]', err)
    res.json({ success: false, message: 'Could not create the order. Please try again.' })
  }
})

// ─── Tool: send_payment_link ──────────────────────────────────────────────────
router.post('/send-payment-link', async (req: Request, res: Response) => {
  if (!verifyAgentSecret(req, res)) return

  try {
    const { orderId, deliveryMethod = 'email' } = req.body as { orderId: string; deliveryMethod?: string }

    const order = await prisma.order.findUnique({
      where:   { id: orderId },
      include: { business: true },
    })

    if (!order) {
      res.json({ success: false, message: 'Order not found.' })
      return
    }

    if (!order.customerEmail) {
      res.json({ success: false, message: 'No customer email available. Please ask for their email address.' })
      return
    }

    const reference = `VB-${uuid().slice(0, 8).toUpperCase()}`

    // Use business's Paystack key if available, else platform key
    const paystackKey = order.business.paystackSecretKey || process.env.PAYSTACK_SECRET_KEY!

    const paymentLink = await createPaymentLink({
      amount:      order.subtotal,
      email:       order.customerEmail,
      reference,
      name:        `Order from ${order.business.name}`,
      description: `Order #${order.id.slice(-6).toUpperCase()} — ${(order.items as any[]).map((i: any) => i.name).join(', ')}`,
      metadata:    { orderId: order.id, businessId: order.businessId, callId: order.callId },
      secretKey:   paystackKey,
    })

    // Update order with payment reference
    await prisma.order.update({
      where: { id: orderId },
      data:  { paystackRef: reference, paystackLinkUrl: paymentLink.url, paystackLinkCode: paymentLink.code },
    })

    // Send email with payment link
    await sendPaymentEmail({
      to:          order.customerEmail,
      customerName: order.customerName || 'Customer',
      businessName: order.business.name,
      amount:       order.subtotal,
      paymentUrl:   paymentLink.url,
      orderId:      order.id,
    })

    res.json({
      success:     true,
      message:     `Payment link sent to ${order.customerEmail}. The link will expire in 24 hours.`,
      paymentUrl:  paymentLink.url,
      reference,
    })
  } catch (err) {
    console.error('[send-payment-link]', err)
    res.json({ success: false, message: 'Could not generate payment link. Please try again.' })
  }
})

// ─── Tool: check_payment_status ───────────────────────────────────────────────
router.post('/payment-status', async (req: Request, res: Response) => {
  if (!verifyAgentSecret(req, res)) return

  try {
    const { orderId } = req.body as { orderId: string }

    const order = await prisma.order.findUnique({ where: { id: orderId } })
    if (!order) {
      res.json({ paid: false, status: 'not_found' })
      return
    }

    if (order.status === 'PAID') {
      res.json({ paid: true, message: 'Payment received! Your order has been confirmed.' })
      return
    }

    res.json({ paid: false, status: order.status, message: 'Payment not yet received. The link is still active.' })
  } catch (err) {
    res.json({ paid: false, message: 'Could not check payment status.' })
  }
})

// ─── Tool: search_businesses ──────────────────────────────────────────────────
router.post('/search-businesses', async (req: Request, res: Response) => {
  if (!verifyAgentSecret(req, res)) return

  try {
    const { category, city, query } = req.body as { category?: string; city?: string; query: string }

    const businesses = await prisma.business.findMany({
      where: {
        isActive: true,
        OR: [
          category ? { category: { equals: category.toUpperCase() as any } } : {},
          { name:        { contains: query, mode: 'insensitive' } },
          { description: { contains: query, mode: 'insensitive' } },
          city ? { city: { contains: city, mode: 'insensitive' } } : {},
        ],
      },
      select: {
        name:     true,
        category: true,
        city:     true,
        phone:    true,
        address:  true,
        aiPhoneNumber: true,
      },
      take: 3,
    })

    if (businesses.length === 0) {
      res.json({ found: false, message: 'No registered businesses found matching your request.' })
      return
    }

    const results = businesses.map(b =>
      `${b.name} (${b.category}) — ${b.city || ''} — ${b.aiPhoneNumber || b.phone || 'contact available'}`
    )

    res.json({
      found:    true,
      businesses: results,
      message:  `I found ${businesses.length} business(es): ${results.join('; ')}`,
    })
  } catch (err) {
    res.json({ found: false, message: 'Could not search businesses right now.' })
  }
})

// ─── Helper: send payment email ───────────────────────────────────────────────
async function sendPaymentEmail(params: {
  to:           string
  customerName: string
  businessName: string
  amount:       number
  paymentUrl:   string
  orderId:      string
}) {
  // If no SENDGRID key, log and skip (dev mode)
  if (!process.env.SENDGRID_API_KEY && process.env.NODE_ENV === 'development') {
    console.log(`[DEV] Payment email would be sent to ${params.to}: ${params.paymentUrl}`)
    return
  }

  const transporter = nodemailer.createTransport({
    host:   'smtp.sendgrid.net',
    port:   587,
    secure: false,
    auth:   { user: 'apikey', pass: process.env.SENDGRID_API_KEY },
  })

  await transporter.sendMail({
    from:    `"${process.env.EMAIL_FROM_NAME || 'VoiceBridge'}" <${process.env.EMAIL_FROM || 'noreply@voicebridge.io'}>`,
    to:      params.to,
    subject: `Payment required — Order from ${params.businessName}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px">
        <h2 style="margin:0 0 8px">Hi ${params.customerName},</h2>
        <p>Your order from <strong>${params.businessName}</strong> is ready for payment.</p>
        <div style="background:#f5f5f5;border-radius:8px;padding:20px;margin:24px 0">
          <p style="margin:0;font-size:14px;color:#666">Order Total</p>
          <p style="margin:4px 0 0;font-size:28px;font-weight:700">₦${params.amount.toLocaleString()}</p>
        </div>
        <a href="${params.paymentUrl}"
           style="display:block;background:#6366f1;color:#fff;text-align:center;padding:16px;border-radius:10px;text-decoration:none;font-weight:600;font-size:16px">
          Pay Now (Secure via Paystack)
        </a>
        <p style="margin-top:20px;font-size:12px;color:#999">
          Order reference: ${params.orderId.slice(-8).toUpperCase()}<br/>
          This link expires in 24 hours. Powered by VoiceBridge.
        </p>
      </div>
    `,
  })
}

export default router
