import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma.js'
import { verifyWebhookSignature, createTransferRecipient, initiateTransfer } from '../services/paystack.js'
import { sendOrderReceiptEmail, sendBusinessOrderAlertEmail } from '../services/email.js'

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

      // ── Automated Payout (Transfer) ──────────────────────────────────────
      const biz = order.business
      if (biz.bankName && biz.accountNumber && biz.accountName) {
        try {
          console.log(`[Paystack Webhook] Initiating payout to ${biz.name} (${biz.bankName})`)
          
          // 1. Create Recipient
          const recipientCode = await createTransferRecipient(
            biz.accountName,
            biz.accountNumber,
            biz.bankName
          )

          // 2. Initiate Transfer (100% of subtotal for now)
          const transferRef = await initiateTransfer(
            order.subtotal,
            recipientCode,
            `Payout for Order #${order.id.slice(-6).toUpperCase()}`
          )

          console.log(`[Paystack Webhook] Payout successful. Transfer Ref: ${transferRef}`)
        } catch (err: any) {
          console.error(`[Paystack Webhook] Payout failed for Order ${order.id}:`, err.message)
          // In a production app, we would flag this order for manual review/retry in the admin panel
        }
      } else {
        console.warn(`[Paystack Webhook] Cannot payout Order ${order.id}: Business ${biz.name} is missing bank details.`)
      }

      // ... later in the file ...

      // Notify business via webhook if configured
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

      // Send email receipt to customer
      if (order.customerEmail) {
        sendOrderReceiptEmail({
          to: order.customerEmail,
          customerName: order.customerName || 'Customer',
          businessName: order.business.name,
          amount: order.subtotal,
          items: typeof order.items === 'string' ? order.items : JSON.stringify(order.items), // assuming items is serialized
        }).catch(err => console.error('[Receipt Email Error]', err))
      }

      // Send email alert to business owner
      if (order.business.notificationEmail) {
         sendBusinessOrderAlertEmail({
           to: order.business.notificationEmail,
           businessName: order.business.name,
           orderId: order.id,
           amount: order.subtotal,
           customerName: order.customerName || 'Customer',
           customerPhone: order.customerPhone || 'N/A',
           deliveryAddress: order.deliveryAddress || 'N/A',
           items: typeof order.items === 'string' ? order.items : JSON.stringify(order.items),
         }).catch(err => console.error('[Business Alert Email Error]', err))
      }
    }
  } catch (err) {
    console.error('[Paystack Webhook] Processing error:', err)
  }
})

export default router
