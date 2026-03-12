import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import { rateLimit } from 'express-rate-limit'
import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

dotenv.config()

// Routes
import authRouter from './routes/auth.js'
import businessRouter from './routes/business.js'
import knowledgeRouter from './routes/knowledge.js'
import catalogRouter from './routes/catalog.js'
import callsRouter from './routes/calls.js'
import ordersRouter from './routes/orders.js'
import agentRouter from './routes/agent.js'
import publicRouter from './routes/public.js'
import billingRouter from './routes/billing.js'

// Webhooks (raw body needed)
import paystackWebhook from './webhooks/paystack.js'
import elevenlabsWebhook from './webhooks/elevenlabs.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname  = path.dirname(__filename)

const app  = express()
const PORT = process.env.PORT || 5000

// ─── Security & middleware ────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}))

app.use(cors({
  origin: [
    process.env.FRONTEND_URL || 'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:4173',
  ],
  credentials: true,
}))

// Webhooks need raw body — mount BEFORE express.json()
app.use('/webhooks/paystack',    express.raw({ type: 'application/json' }), paystackWebhook)
app.use('/webhooks/elevenlabs',  express.raw({ type: 'application/json' }), elevenlabsWebhook)

app.use(express.json({ limit: '10mb' }))
app.use(express.urlencoded({ extended: true }))

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
})
app.use('/api', limiter)

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')))

// ─── API Routes ───────────────────────────────────────────────────────────────
app.use('/api/auth',        authRouter)
app.use('/api/business',    businessRouter)
app.use('/api/knowledge',   knowledgeRouter)
app.use('/api/catalog',     catalogRouter)
app.use('/api/calls',       callsRouter)
app.use('/api/orders',      ordersRouter)
app.use('/api/agent',       agentRouter)
app.use('/api/billing',     billingRouter)
app.use('/api/public',      publicRouter)   // public endpoint called by ElevenLabs agent tools

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

// ─── Global error handler ─────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('[Error]', err.message)
  res.status(500).json({ error: 'Internal server error', message: process.env.NODE_ENV === 'development' ? err.message : undefined })
})

app.listen(PORT, () => {
  console.log(`🚀 VoiceBridge API running on port ${PORT}`)
  console.log(`   ENV: ${process.env.NODE_ENV}`)
  console.log(`   DB:  ${process.env.DATABASE_URL?.split('@')[1]?.split('/')[0] || 'configured'}`)
})

export default app
