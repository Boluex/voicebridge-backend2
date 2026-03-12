import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma.js'
import { verifyWebhookSignature } from '../services/paystack.js'

const router = Router()

router.post('/', async (req: Request, res: Response) => {
  const signature = req.headers['x-paystack-signature'] as string

  if (!verifyWebhookSignature(req.body as Buffer, signature)) {
    console.warn('[Paystack Webhook] Invalid signature')
    res.status(400).json({ error: 'Invalid signature' })
    return
  }

  // Acknowledge immediately — Paystack expects fast response
  res.status(200).json({ received: true })

  try {
    const event = JSON.parse((req.body as Buffer).toString())
    console.log(`[Paystack Webhook] Event: ${event.event}`)

    if (event.event === 'charge.success') {
      const { reference, metadata } = event.data as {
        reference: string
        metadata: { orderId?: string; businessId?: string; type?: string; days?: number; plan?: string }
      }

      // ── Agent billing payment ────────────────────────────────────────────
      if (metadata?.type === 'agent_billing' && metadata?.businessId) {
        const biz = await prisma.business.findUnique({ where: { id: metadata.businessId } })
        if (biz) {
          const days = metadata.days || 30
          const now = new Date()
          // Extend from today or existing expiry (whichever is later)
          const baseDate = biz.subscriptionExpiry && new Date(biz.subscriptionExpiry) > now
            ? new Date(biz.subscriptionExpiry)
            : now
          const newExpiry = new Date(baseDate)
          newExpiry.setDate(newExpiry.getDate() + days)

          await prisma.business.update({
            where: { id: biz.id },
            data: {
              subscriptionStatus: 'active',
              subscriptionPlan: metadata.plan || 'STARTER',
              subscriptionExpiry: newExpiry,
              billingCycleStart: now,
              lastBilledAt: now,
            },
          })
          console.log(`[Paystack Webhook] Agent billing: ${biz.name} active until ${newExpiry.toISOString()}`)
        }
        return
      }

      // ── Order payment ────────────────────────────────────────────────────
      if (!metadata?.orderId) {
        console.warn('[Paystack Webhook] No orderId in metadata')
        return
      }

      // Update order status
      const order = await prisma.order.update({
        where:   { paystackRef: reference },
        data:    { status: 'PAID', paidAt: new Date() },
        include: { business: true },
      })

      console.log(`[Paystack Webhook] Order ${order.id} marked as PAID`)

      // Notify business via webhook
      if (order.business.orderWebhookUrl) {
        fetch(order.business.orderWebhookUrl, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            event:   'order.paid',
            orderId: order.id,
            items:   order.items,
            amount:  order.subtotal,
            customer: {
              name:    order.customerName,
              email:   order.customerEmail,
              phone:   order.customerPhone,
              address: order.deliveryAddress,
            },
          }),
        }).catch(err => console.error('[Business webhook]', err))
      }
    }
  } catch (err) {
    console.error('[Paystack Webhook] Processing error:', err)
  }
})

export default router
