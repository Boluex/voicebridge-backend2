/**
 * Billing Routes — agent subscription & schedule management
 * POST /api/billing/:bizId/activate   — activate/extend agent subscription
 * GET  /api/billing/:bizId/status     — get current billing status
 * POST /api/billing/paystack/callback — Paystack callback for billing payments
 */

import { Router, Request, Response } from 'express'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import prisma from '../lib/prisma.js'
import { createPaymentLink } from '../services/paystack.js'
import { v4 as uuid } from 'uuid'

const router = Router()

// Public callback — no auth needed
router.post('/paystack/callback', async (req: Request, res: Response) => {
  // This is triggered after Paystack payment for agent billing
  // Actual confirmation comes via webhook at /webhooks/paystack
  res.json({ received: true })
})

router.use(authenticate)

const PLANS = {
  STARTER: { pricePerDay: 500, name: 'Starter', maxDays: 30 },         // ₦500/day
  PROFESSIONAL: { pricePerDay: 1500, name: 'Professional', maxDays: 30 }, // ₦1500/day
  ENTERPRISE: { pricePerDay: 3000, name: 'Enterprise', maxDays: 30 },   // ₦3000/day
}

// GET /api/billing/:bizId/status
router.get('/:bizId/status', async (req: AuthRequest, res: Response) => {
  const biz = await prisma.business.findFirst({
    where: { id: req.params.bizId, userId: req.user!.id },
  })
  if (!biz) { res.status(404).json({ error: 'Not found' }); return }

  const now = new Date()
  const isActive = biz.subscriptionStatus === 'active' &&
    biz.subscriptionExpiry != null &&
    new Date(biz.subscriptionExpiry) > now

  const daysLeft = biz.subscriptionExpiry
    ? Math.max(0, Math.ceil((new Date(biz.subscriptionExpiry).getTime() - now.getTime()) / (1000 * 60 * 60 * 24)))
    : 0

  res.json({
    status: biz.subscriptionStatus,
    plan: biz.plan,
    isActive,
    daysLeft,
    subscriptionExpiry: biz.subscriptionExpiry,
    trialEndsAt: biz.trialEndsAt,
    agentScheduleType: biz.agentScheduleType,
    agentActiveDays: biz.agentActiveDays,
    agentStartTime: biz.agentStartTime,
    agentEndTime: biz.agentEndTime,
    pricing: PLANS,
  })
})

// POST /api/billing/:bizId/activate — create Paystack payment link for subscription
router.post('/:bizId/activate', async (req: AuthRequest, res: Response) => {
  try {
    const biz = await prisma.business.findFirst({
      where: { id: req.params.bizId, userId: req.user!.id },
    })
    if (!biz) { res.status(404).json({ error: 'Not found' }); return }

    const { days = 30, plan = 'STARTER', email } = req.body as {
      days?: number
      plan?: keyof typeof PLANS
      email?: string
    }

    const planDetails = PLANS[plan] || PLANS.STARTER
    const billingDays = Math.min(Math.max(1, days), planDetails.maxDays)
    const totalAmount = planDetails.pricePerDay * billingDays

    const customerEmail = email || biz.notificationEmail
    if (!customerEmail) {
      res.status(400).json({ error: 'Email required for billing. Add a notification email in Settings.' })
      return
    }

    const reference = `VB-BILLING-${uuid().slice(0, 8).toUpperCase()}`

    const paymentLink = await createPaymentLink({
      amount: totalAmount,
      email: customerEmail,
      reference,
      name: `VoiceBridge ${planDetails.name} — ${billingDays} days`,
      description: `AI Agent subscription for ${biz.name} — ${billingDays} days @ ₦${planDetails.pricePerDay.toLocaleString()}/day`,
      metadata: {
        type: 'agent_billing',
        businessId: biz.id,
        days: billingDays,
        plan,
      },
      secretKey: process.env.PAYSTACK_SECRET_KEY,
    })

    // Store reference so webhook can update subscription on payment
    await prisma.business.update({
      where: { id: biz.id },
      data: {
        // Temporarily store reference in subscriptionPlan for webhook lookup
        subscriptionPlan: `PENDING:${reference}:${billingDays}:${plan}`,
      },
    })

    res.json({
      paymentUrl: paymentLink.url,
      reference,
      amount: totalAmount,
      days: billingDays,
      plan: planDetails.name,
      message: `Pay ₦${totalAmount.toLocaleString()} to activate your agent for ${billingDays} days`,
    })
  } catch (err) {
    console.error('[billing activate]', err)
    res.status(500).json({ error: 'Failed to create payment link' })
  }
})

// PATCH /api/billing/:bizId/schedule — update when agent is active
router.patch('/:bizId/schedule', async (req: AuthRequest, res: Response) => {
  const biz = await prisma.business.findFirst({
    where: { id: req.params.bizId, userId: req.user!.id },
  })
  if (!biz) { res.status(404).json({ error: 'Not found' }); return }

  const { agentScheduleType, agentActiveDays, agentStartTime, agentEndTime } = req.body as {
    agentScheduleType?: string
    agentActiveDays?: string[]
    agentStartTime?: string
    agentEndTime?: string
  }

  const updated = await prisma.business.update({
    where: { id: biz.id },
    data: {
      ...(agentScheduleType !== undefined && { agentScheduleType }),
      ...(agentActiveDays   !== undefined && { agentActiveDays }),
      ...(agentStartTime    !== undefined && { agentStartTime }),
      ...(agentEndTime      !== undefined && { agentEndTime }),
    },
  })

  res.json({ business: updated })
})

export default router
