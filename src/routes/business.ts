import { Router, Response } from 'express'
import { z } from 'zod'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import prisma from '../lib/prisma.js'
import { createElevenLabsAgent, deleteElevenLabsAgent } from '../services/elevenlabs.js'

const router = Router()
router.use(authenticate)

const BusinessSchema = z.object({
  name:             z.string().min(2),
  category:         z.string(),
  description:      z.string().optional(),
  phone:            z.string().optional(),
  email:            z.string().email().optional().or(z.literal('')),
  address:          z.string().optional(),
  city:             z.string().optional(),
  country:          z.string().optional(),
  deliveryRadius:   z.number().optional(),
  operatingHours:   z.any().optional(),
  paystackPublicKey:  z.string().optional(),
  paystackSecretKey:  z.string().optional(),
  orderWebhookUrl:    z.string().optional(),
  notificationEmail:  z.string().optional(),
  escalationPhone:    z.string().optional(),
  // Schedule & billing
  agentScheduleType:  z.string().optional(),
  agentActiveDays:    z.any().optional(),
  agentStartTime:     z.string().optional(),
  agentEndTime:       z.string().optional(),
})

function makeSlug(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Date.now()
}

// GET /api/business
router.get('/', async (req: AuthRequest, res: Response) => {
  const businesses = await prisma.business.findMany({
    where: { userId: req.user!.id },
    include: { _count: { select: { calls: true, orders: true, knowledgeSources: true } } },
    orderBy: { createdAt: 'desc' },
  })
  res.json({ businesses })
})

// GET /api/business/:id
router.get('/:id', async (req: AuthRequest, res: Response) => {
  const biz = await prisma.business.findFirst({
    where: { id: req.params.id, userId: req.user!.id },
    include: { knowledgeSources: true, _count: { select: { calls: true, orders: true, catalogItems: true } } },
  })
  if (!biz) { res.status(404).json({ error: 'Business not found' }); return }
  res.json({ business: biz })
})

// POST /api/business — create + provision ElevenLabs agent
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const data = BusinessSchema.parse(req.body)

    // Trial ends 14 days from now
    const trialEndsAt = new Date()
    trialEndsAt.setDate(trialEndsAt.getDate() + 14)

    const biz = await prisma.business.create({
      data: {
        ...data,
        slug:        makeSlug(data.name),
        category:    data.category as any,
        userId:      req.user!.id,
        trialEndsAt,
        subscriptionStatus: 'trial',
      },
    })

    // Create ElevenLabs agent in background — don't block the response
    ;(async () => {
      try {
        console.log(`[Business] Creating ElevenLabs agent for "${biz.name}"...`)
        const { agentId, phoneNumber } = await createElevenLabsAgent(biz as any)
        if (agentId) {
          await prisma.business.update({
            where: { id: biz.id },
            data:  { agentId, aiPhoneNumber: phoneNumber || biz.aiPhoneNumber },
          })
          console.log(`[Business] ✓ Agent ${agentId} linked to "${biz.name}"`)
        }
      } catch (err) {
        console.error(`[Business] ✗ ElevenLabs agent creation failed for "${biz.name}":`, err)
      }
    })()

    res.status(201).json({ business: biz })
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors }); return
    }
    console.error('[business create]', err)
    res.status(500).json({ error: 'Failed to create business' })
  }
})

// PATCH /api/business/:id
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const biz = await prisma.business.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
    if (!biz) { res.status(404).json({ error: 'Not found' }); return }

    const data = BusinessSchema.partial().parse(req.body)
    const updated = await prisma.business.update({
      where: { id: req.params.id },
      data:  { ...data, category: data.category as any },
    })

    // Sync profile changes to ElevenLabs agent in background
    if (updated.agentId) {
      const { updateElevenLabsAgent } = await import('../services/elevenlabs.js')
      updateElevenLabsAgent(updated.agentId, updated as any).catch((err: Error) =>
        console.error('[business patch] ElevenLabs sync failed:', err.message)
      )
    }

    res.json({ business: updated })
  } catch (err) {
    if (err instanceof z.ZodError) {
      res.status(400).json({ error: 'Validation error', details: err.errors }); return
    }
    res.status(500).json({ error: 'Failed to update' })
  }
})

// DELETE /api/business/:id
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const biz = await prisma.business.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
  if (!biz) { res.status(404).json({ error: 'Not found' }); return }
  if (biz.agentId) deleteElevenLabsAgent(biz.agentId).catch(console.error)
  await prisma.business.delete({ where: { id: req.params.id } })
  res.json({ success: true })
})

// GET /api/business/:id/stats
router.get('/:id/stats', async (req: AuthRequest, res: Response) => {
  const biz = await prisma.business.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
  if (!biz) { res.status(404).json({ error: 'Not found' }); return }

  const today = new Date(); today.setHours(0, 0, 0, 0)

  const [callsToday, ordersToday, totalOrders, paidOrders, recentCalls] = await Promise.all([
    prisma.call.count({ where: { businessId: biz.id, startedAt: { gte: today } } }),
    prisma.order.count({ where: { businessId: biz.id, createdAt: { gte: today } } }),
    prisma.order.count({ where: { businessId: biz.id } }),
    prisma.order.findMany({ where: { businessId: biz.id, status: 'PAID' }, select: { subtotal: true } }),
    prisma.call.findMany({ where: { businessId: biz.id }, orderBy: { startedAt: 'desc' }, take: 5 }),
  ])

  res.json({
    callsToday,
    ordersToday,
    totalOrders,
    totalRevenue: paidOrders.reduce((s, o) => s + o.subtotal, 0),
    recentCalls,
    subscription: {
      status:  biz.subscriptionStatus,
      plan:    biz.subscriptionPlan,
      trialEndsAt: biz.trialEndsAt,
      expiry:  biz.subscriptionExpiry,
    },
  })
})

// PATCH /api/business/:id/schedule — update agent schedule
router.patch('/:id/schedule', async (req: AuthRequest, res: Response) => {
  const biz = await prisma.business.findFirst({ where: { id: req.params.id, userId: req.user!.id } })
  if (!biz) { res.status(404).json({ error: 'Not found' }); return }

  const { agentScheduleType, agentActiveDays, agentStartTime, agentEndTime } = req.body as {
    agentScheduleType?: string
    agentActiveDays?: string[]
    agentStartTime?: string
    agentEndTime?: string
  }

  const updated = await prisma.business.update({
    where: { id: req.params.id },
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