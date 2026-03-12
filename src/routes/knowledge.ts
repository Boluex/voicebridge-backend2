import { Router, Response } from 'express'
import multer from 'multer'
import path from 'path'
import fs from 'fs'
import { authenticate, AuthRequest } from '../middleware/auth.js'
import prisma from '../lib/prisma.js'
import { extractAndSummarize } from '../services/aiExtractor.js'
import { updateElevenLabsAgent } from '../services/elevenlabs.js'

const router = Router()
router.use(authenticate)

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const dir = process.env.UPLOAD_DIR || './uploads'
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    cb(null, dir)
  },
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname)
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`)
  },
})

const upload = multer({
  storage,
  limits: { fileSize: (parseInt(process.env.MAX_FILE_SIZE_MB || '20')) * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['.pdf', '.doc', '.docx', '.csv', '.txt', '.xlsx', '.jpg', '.jpeg', '.png', '.webp', '.gif']
    const ext = path.extname(file.originalname).toLowerCase()
    if (allowed.includes(ext)) cb(null, true)
    else cb(new Error(`File type ${ext} not supported`))
  },
})

async function ownsBusiness(userId: string, businessId: string) {
  return !!(await prisma.business.findFirst({ where: { id: businessId, userId } }))
}

// GET /api/knowledge/:businessId
router.get('/:businessId', async (req: AuthRequest, res: Response) => {
  if (!(await ownsBusiness(req.user!.id, req.params.businessId))) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  const sources = await prisma.knowledgeSource.findMany({
    where:   { businessId: req.params.businessId },
    orderBy: { createdAt: 'desc' },
    select:  { id: true, type: true, name: true, source: true, fileUrl: true, fileSize: true, chunkCount: true, status: true, createdAt: true },
  })
  res.json({ sources })
})

// POST /api/knowledge/:businessId/url
router.post('/:businessId/url', async (req: AuthRequest, res: Response) => {
  if (!(await ownsBusiness(req.user!.id, req.params.businessId))) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  const { url } = req.body as { url: string }
  if (!url) { res.status(400).json({ error: 'URL required' }); return }

  const source = await prisma.knowledgeSource.create({
    data: { businessId: req.params.businessId, type: 'URL', name: url, source: url, status: 'PROCESSING' },
  })

  // Background processing
  processSource(source.id, 'url', url, req.params.businessId).catch(console.error)

  res.status(201).json({ source })
})

// POST /api/knowledge/:businessId/file  (PDF, DOCX, CSV, TXT, images)
router.post('/:businessId/file', upload.single('file'), async (req: AuthRequest, res: Response) => {
  if (!(await ownsBusiness(req.user!.id, req.params.businessId))) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  if (!req.file) { res.status(400).json({ error: 'File required' }); return }

  const ext  = path.extname(req.file.originalname).toLowerCase().replace('.', '').toUpperCase()
  const imageExts = ['JPG', 'JPEG', 'PNG', 'WEBP', 'GIF']
  // Map DOC → DOCX (DOC is not a separate enum value)
  const normalizedExt = ext === 'DOC' ? 'DOCX' : ext
  const type = imageExts.includes(normalizedExt)
    ? ('IMAGE' as any)
    : (['PDF', 'DOCX', 'CSV', 'TXT', 'XLSX'].includes(normalizedExt) ? (normalizedExt as any) : 'PDF')

  const source = await prisma.knowledgeSource.create({
    data: {
      businessId: req.params.businessId,
      type,
      name:    req.file.originalname.replace(/\.[^.]+$/, ''),
      source:  req.file.originalname,
      fileUrl: `/uploads/${req.file.filename}`,
      fileSize: req.file.size,
      status:  'PROCESSING',
    },
  })

  processSource(source.id, type.toLowerCase(), req.file.path, req.params.businessId).catch(console.error)

  res.status(201).json({ source })
})

// POST /api/knowledge/:businessId/faq
router.post('/:businessId/faq', async (req: AuthRequest, res: Response) => {
  if (!(await ownsBusiness(req.user!.id, req.params.businessId))) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  const { content, name } = req.body as { content: string; name?: string }
  if (!content) { res.status(400).json({ error: 'Content required' }); return }

  const source = await prisma.knowledgeSource.create({
    data: {
      businessId: req.params.businessId,
      type:       'FAQ',
      name:       name || 'FAQ',
      content,
      chunkCount: (content.match(/^Q:/gim) || []).length || 1,
      status:     'INDEXED',
    },
  })

  // Push updated knowledge to ElevenLabs
  pushKnowledgeToAgent(req.params.businessId).catch(console.error)

  res.status(201).json({ source })
})

// DELETE /api/knowledge/:businessId/:sourceId
router.delete('/:businessId/:sourceId', async (req: AuthRequest, res: Response) => {
  if (!(await ownsBusiness(req.user!.id, req.params.businessId))) {
    res.status(403).json({ error: 'Forbidden' }); return
  }
  const source = await prisma.knowledgeSource.findFirst({
    where: { id: req.params.sourceId, businessId: req.params.businessId },
  })
  if (!source) { res.status(404).json({ error: 'Not found' }); return }

  if (source.fileUrl) {
    const uploadDir = (process.env.UPLOAD_DIR || './uploads').replace(/\/$/, '')
    const filename = source.fileUrl.replace(/^\/uploads\//, '')
    const filePath = `${uploadDir}/${filename}`
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  }

  await prisma.knowledgeSource.delete({ where: { id: source.id } })
  res.json({ success: true })
})

// ─── Background processor ──────────────────────────────────────────────────────
async function processSource(sourceId: string, type: string, inputPath: string, businessId: string) {
  try {
    const extractedText = await extractAndSummarize(type, inputPath)
    const chunks = Math.max(1, Math.ceil(extractedText.length / 500))

    await prisma.knowledgeSource.update({
      where: { id: sourceId },
      data:  { content: extractedText, chunkCount: chunks, status: 'INDEXED' },
    })

    console.log(`[Knowledge] ✓ Indexed ${type} (${chunks} chunks) for business ${businessId}`)

    // Push all indexed knowledge to ElevenLabs agent
    await pushKnowledgeToAgent(businessId)

  } catch (err) {
    await prisma.knowledgeSource.update({
      where: { id: sourceId },
      data:  { status: 'ERROR' },
    })
    console.error(`[Knowledge] ✗ Failed to process ${type}:`, err)
  }
}

async function pushKnowledgeToAgent(businessId: string) {
  try {
    const [business, sources] = await Promise.all([
      prisma.business.findUnique({ where: { id: businessId } }),
      prisma.knowledgeSource.findMany({
        where:   { businessId, status: 'INDEXED' },
        select:  { type: true, name: true, content: true },
      }),
    ])

    if (!business?.agentId) return

    // Build combined knowledge text (cap at 8000 chars for prompt)
    const combined = sources
      .filter(s => s.content)
      .map(s => `=== ${s.name} (${s.type}) ===\n${s.content}`)
      .join('\n\n')
      .slice(0, 8000)

    // Update agent system prompt with new knowledge
    await updateElevenLabsAgent(business.agentId, business as any, combined)
    console.log(`[ElevenLabs] ✓ Agent ${business.agentId} updated with fresh knowledge`)
  } catch (err) {
    console.error('[pushKnowledgeToAgent]', err)
  }
}

export default router