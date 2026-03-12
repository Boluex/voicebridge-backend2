import { Router, Response } from 'express'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import prisma from '../lib/prisma.js'

// ─── CALLS ────────────────────────────────────────────────────────────────────
export const callsRouter = Router()
callsRouter.use(authenticate)

callsRouter.get('/:businessId', async (req: AuthRequest, res: Response) => {
  const biz = await prisma.business.findFirst({ where: { id: req.params.businessId, userId: req.user!.id } })
  if (!biz) { res.status(403).json({ error: 'Forbidden' }); return }

  const calls = await prisma.call.findMany({
    where:   { businessId: req.params.businessId },
    orderBy: { startedAt: 'desc' },
    take:    50,
  })
  res.json({ calls })
})

// ─── ORDERS ───────────────────────────────────────────────────────────────────
export const ordersRouter = Router()
ordersRouter.use(authenticate)

ordersRouter.get('/:businessId', async (req: AuthRequest, res: Response) => {
  const biz = await prisma.business.findFirst({ where: { id: req.params.businessId, userId: req.user!.id } })
  if (!biz) { res.status(403).json({ error: 'Forbidden' }); return }

  const orders = await prisma.order.findMany({
    where:   { businessId: req.params.businessId },
    orderBy: { createdAt: 'desc' },
    take:    50,
  })
  res.json({ orders })
})

// ─── CATALOG ──────────────────────────────────────────────────────────────────
export const catalogRouter = Router()
catalogRouter.use(authenticate)

async function ownsBiz(userId: string, businessId: string) {
  return !!(await prisma.business.findFirst({ where: { id: businessId, userId } }))
}

catalogRouter.get('/:businessId', async (req: AuthRequest, res: Response) => {
  if (!(await ownsBiz(req.user!.id, req.params.businessId))) { res.status(403).json({ error: 'Forbidden' }); return }
  const items = await prisma.catalogItem.findMany({ where: { businessId: req.params.businessId }, orderBy: { createdAt: 'desc' } })
  res.json({ items })
})

catalogRouter.post('/:businessId', async (req: AuthRequest, res: Response) => {
  if (!(await ownsBiz(req.user!.id, req.params.businessId))) { res.status(403).json({ error: 'Forbidden' }); return }
  const item = await prisma.catalogItem.create({ data: { ...req.body, businessId: req.params.businessId } })
  res.status(201).json({ item })
})

catalogRouter.patch('/:businessId/:itemId', async (req: AuthRequest, res: Response) => {
  if (!(await ownsBiz(req.user!.id, req.params.businessId))) { res.status(403).json({ error: 'Forbidden' }); return }
  const item = await prisma.catalogItem.update({ where: { id: req.params.itemId }, data: req.body })
  res.json({ item })
})

catalogRouter.delete('/:businessId/:itemId', async (req: AuthRequest, res: Response) => {
  if (!(await ownsBiz(req.user!.id, req.params.businessId))) { res.status(403).json({ error: 'Forbidden' }); return }
  await prisma.catalogItem.delete({ where: { id: req.params.itemId } })
  res.json({ success: true })
})

// ─── AGENT CONFIG ─────────────────────────────────────────────────────────────
export const agentRouter = Router()
agentRouter.use(authenticate)

import { updateElevenLabsAgent, getVoiceModels, getAgentSignedUrl } from '../services/elevenlabs.js'

// GET /api/agent/voices  — list ElevenLabs voices
agentRouter.get('/voices', async (_req, res: Response) => {
  try {
    const voices = await getVoiceModels()
    res.json({ voices })
  } catch {
    // Return hardcoded fallback if API fails
    res.json({
      voices: [
        { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', gender: 'female' },
        { id: 'AZnzlk1XvdvUeBnXmlld', name: 'Domi',   gender: 'female' },
        { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella',  gender: 'female' },
        { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', gender: 'male'   },
        { id: 'VR6AewLTigWG4xSOukaG', name: 'Arnold', gender: 'male'   },
        { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam',   gender: 'male'   },
      ],
    })
  }
})

// PATCH /api/agent/:businessId  — update agent config + push to ElevenLabs
agentRouter.patch('/:businessId', async (req: AuthRequest, res: Response) => {
  if (!(await ownsBiz(req.user!.id, req.params.businessId))) { res.status(403).json({ error: 'Forbidden' }); return }

  const allowedFields = ['agentName','agentGender','agentVoiceId','agentGreeting','agentTone',
    'primaryLanguage','multilingualOn','recordCalls','autoEscalate','escalationPhone']

  const updates: Record<string, unknown> = {}
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field]
  }

  const biz = await prisma.business.update({
    where: { id: req.params.businessId },
    data:  updates,
  })

  // Push config to ElevenLabs if agent exists
  if (biz.agentId) {
    updateElevenLabsAgent(biz.agentId, biz as any).catch(console.error)
  }

  res.json({ business: biz })
})

// GET /api/agent/:businessId/widget-url — get signed URL for embedded widget
agentRouter.get('/:businessId/widget-url', async (req: AuthRequest, res: Response) => {
  if (!(await ownsBiz(req.user!.id, req.params.businessId))) { res.status(403).json({ error: 'Forbidden' }); return }
  const biz = await prisma.business.findUnique({ where: { id: req.params.businessId } })
  if (!biz?.agentId) { res.status(404).json({ error: 'No agent configured' }); return }
  try {
    const signedUrl = await getAgentSignedUrl(biz.agentId)
    res.json({ signedUrl })
  } catch (err) {
    res.status(500).json({ error: 'Failed to get widget URL' })
  }
})
