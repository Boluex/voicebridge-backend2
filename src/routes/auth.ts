






import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'

const router = Router()

const RegisterSchema = z.object({
  name:     z.string().min(2),
  email:    z.string().email(),
  password: z.string().min(8),
})

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string(),
})

// Clerk OAuth Schema — when user signs in with Google via Clerk
const ClerkSyncSchema = z.object({
  clerkId:  z.string(),
  email:    z.string().email(),
  name:     z.string(),
  imageUrl: z.string().optional(),
})

function signToken(id: string, email: string) {
  return jwt.sign(
    { id, email },
    process.env.JWT_SECRET!,
    { expiresIn: (process.env.JWT_EXPIRES_IN || '7d') } as jwt.SignOptions
  )
}

// POST /api/auth/register — email/password
router.post('/register', async (req: Request, res: Response) => {
  try {
    const data = RegisterSchema.parse(req.body)
    const exists = await prisma.user.findUnique({ where: { email: data.email } })
    if (exists) { res.status(409).json({ error: 'Email already registered' }); return }

    const passwordHash = await bcrypt.hash(data.password, 12)
    const user = await prisma.user.create({ data: { name: data.name, email: data.email, passwordHash } })
    const token = signToken(user.id, user.email)

    res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } })
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return }
    console.error('[register]', err)
    res.status(500).json({ error: 'Registration failed' })
  }
})

// POST /api/auth/login — email/password
router.post('/login', async (req: Request, res: Response) => {
  try {
    const data = LoginSchema.parse(req.body)
    const user = await prisma.user.findUnique({ where: { email: data.email } })
    if (!user || !user.passwordHash) { res.status(401).json({ error: 'Invalid credentials' }); return }

    const valid = await bcrypt.compare(data.password, user.passwordHash)
    if (!valid) { res.status(401).json({ error: 'Invalid credentials' }); return }

    const token = signToken(user.id, user.email)
    res.json({ token, user: { id: user.id, name: user.name, email: user.email } })
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return }
    res.status(500).json({ error: 'Login failed' })
  }
})

// POST /api/auth/clerk-sync — called by frontend after Clerk Google OAuth
// Creates or finds the user in our DB, returns a VoiceBridge JWT
router.post('/clerk-sync', async (req: Request, res: Response) => {
  try {
    const data = ClerkSyncSchema.parse(req.body)

    let user = await prisma.user.findFirst({
      where: { OR: [{ clerkId: data.clerkId }, { email: data.email }] },
    })

    let isNew = false

    if (!user) {
      // New user — create record
      user = await prisma.user.create({
        data: {
          clerkId:      data.clerkId,
          email:        data.email,
          name:         data.name,
          passwordHash: null, // OAuth users have no password
        },
      })
      isNew = true
      console.log(`[Auth] New Clerk user: ${user.email}`)
    } else if (!user.clerkId) {
      // Existing email/password user — link their Clerk ID
      user = await prisma.user.update({
        where: { id: user.id },
        data:  { clerkId: data.clerkId },
      })
    }

    const token = signToken(user.id, user.email)
    res.json({ token, user: { id: user.id, name: user.name, email: user.email }, isNew })
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return }
    console.error('[clerk-sync]', err)
    res.status(500).json({ error: 'Clerk sync failed' })
  }
})

// GET /api/auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where:  { id: req.user!.id },
    select: { id: true, name: true, email: true, clerkId: true, createdAt: true },
  })
  res.json({ user })
})

export default router