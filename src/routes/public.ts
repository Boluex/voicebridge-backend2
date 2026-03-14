/**
 * Public Tool Endpoints
 * Called by ElevenLabs agents during live calls via webhook tool calling.
 * These MUST respond in under 1.5 seconds to maintain natural conversation flow.
 */

import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma.js'
import { createPaymentLink } from '../services/paystack.js'
import { v4 as uuid } from 'uuid'
import { sendPaymentEmail as sendPaymentResendEmail } from '../services/email.js'

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

// (Removed legacy payment-status tools)

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

    // Use platform Paystack key for all transactions to collect money centrally
    const paystackKey = process.env.PAYSTACK_SECRET_KEY!

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
    const itemsList = (order.items as any[])
      .map((i: any) => `${i.qty}x ${i.name} @ ₦${i.price?.toLocaleString()}`)
      .join(', ')
    await sendPaymentResendEmail({
      to:           order.customerEmail,
      customerName: order.customerName || 'Customer',
      businessName: order.business.name,
      amount:       order.subtotal,
      items:        itemsList,
      paymentUrl:   paymentLink.url,
    })

    res.json({
      success:     true,
      message:     `Payment link sent to ${order.customerEmail}. Tell the caller to check their email and that the link will expire soon.`,
      paymentUrl:  paymentLink.url,
      reference,
    })
  } catch (err) {
    console.error('[send-payment-link]', err)
    res.json({ success: false, message: 'Could not generate payment link. Please try again.' })
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

export default router