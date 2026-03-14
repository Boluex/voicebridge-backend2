import { Router, Request, Response } from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { z } from 'zod'
import prisma from '../lib/prisma.js'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import { sendWelcomeEmail } from '../services/email.js'

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

    // Send welcome email (non-blocking)
    sendWelcomeEmail({ to: user.email, name: user.name }).catch(e =>
      console.error('[register] Welcome email failed:', e.message)
    )

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

// Google OAuth Schema
const GoogleAuthSchema = z.object({
  accessToken: z.string(),
})

// POST /api/auth/google — Verify Google token and login/register user
router.post('/google', async (req: Request, res: Response) => {
  try {
    const { accessToken } = GoogleAuthSchema.parse(req.body)

    // Fetch user profile from Google using the access token
    const googleRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    if (!googleRes.ok) {
      res.status(401).json({ error: 'Invalid Google token' })
      return
    }

    const googleUser = await googleRes.json() as { sub: string; email: string; name: string }

    let user = await prisma.user.findFirst({
      where: { OR: [{ googleId: googleUser.sub }, { email: googleUser.email }] },
    })

    let isNew = false

    if (!user) {
      // New user
      user = await prisma.user.create({
        data: {
          googleId:     googleUser.sub,
          email:        googleUser.email,
          name:         googleUser.name,
          passwordHash: null,
        },
      })
      isNew = true
      console.log(`[Auth] New Google user: ${user.email}`)
      sendWelcomeEmail({ to: user.email, name: user.name }).catch(e =>
        console.error('[google] Welcome email failed:', e.message)
      )
    } else if (!user.googleId) {
      // Link existing email to Google Account
      user = await prisma.user.update({
        where: { id: user.id },
        data:  { googleId: googleUser.sub },
      })
    }

    const token = signToken(user.id, user.email)
    res.json({ token, user: { id: user.id, name: user.name, email: user.email }, isNew })
  } catch (err) {
    if (err instanceof z.ZodError) { res.status(400).json({ error: 'Validation error', details: err.errors }); return }
    console.error('[google]', err)
    res.status(500).json({ error: 'Google sign-in failed' })
  }
})

// GET /api/auth/me
router.get('/me', authenticate, async (req: AuthRequest, res: Response) => {
  const user = await prisma.user.findUnique({
    where:  { id: req.user!.id },
    select: { id: true, name: true, email: true, googleId: true, createdAt: true },
  })
  res.json({ user })
})

export default router