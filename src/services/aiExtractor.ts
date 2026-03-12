import fs from 'fs'
import path from 'path'

type PdfParseResult = { text: string }
type MammothResult = { value: string }

/**
 * Extract and summarize content from various file types.
 * Returns plain text ready to be injected into the ElevenLabs agent system prompt.
 */
export async function extractAndSummarize(type: string, inputPath: string): Promise<string> {
  const ext = type.toLowerCase()

  try {
    // ── Images: OCR extraction ────────────────────────────────────────────────
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'image'].includes(ext)) {
      return await extractImageText(inputPath)
    }

    // ── PDF ──────────────────────────────────────────────────────────────────
    if (ext === 'pdf') {
      try {
        const pdfParseModule = await import('pdf-parse/lib/pdf-parse.js')
        const pdfParse = (pdfParseModule as any).default || pdfParseModule
        const buffer = fs.readFileSync(inputPath)
        const data = await pdfParse(buffer) as PdfParseResult
        const text = cleanText(data.text)
        // If PDF has very little extractable text (scanned), try image OCR
        if (text.length < 100) {
          console.log(`[aiExtractor] PDF has little text, trying image OCR...`)
          return await extractImageText(inputPath, 'pdf')
        }
        return text
      } catch (err) {
        console.error('[aiExtractor] pdf-parse failed:', (err as Error).message)
        return `[PDF content from ${path.basename(inputPath)} — extraction failed]`
      }
    }

    // ── Word documents ───────────────────────────────────────────────────────
    if (['doc', 'docx'].includes(ext)) {
      try {
        const mammoth = await import('mammoth')
        const result = await (mammoth as any).extractRawText({ path: inputPath }) as MammothResult
        return cleanText(result.value)
      } catch (err) {
        console.error('[aiExtractor] mammoth failed:', (err as Error).message)
        return `[DOCX content from ${path.basename(inputPath)} — extraction failed]`
      }
    }

    // ── Plain text / CSV ─────────────────────────────────────────────────────
    if (['txt', 'csv'].includes(ext)) {
      return cleanText(fs.readFileSync(inputPath, 'utf-8'))
    }

    // ── XLSX — read as raw text ───────────────────────────────────────────────
    if (ext === 'xlsx') {
      try {
        const content = fs.readFileSync(inputPath, 'utf-8')
        return cleanText(content)
      } catch {
        return `[XLSX content from ${path.basename(inputPath)} — binary format, text extraction limited]`
      }
    }

    // ── Website URL scraping ─────────────────────────────────────────────────
    if (ext === 'url') {
      return await scrapeWebsite(inputPath)
    }

    return `[Content from ${type} file — unsupported format]`

  } catch (err) {
    console.error(`[aiExtractor] Error processing ${type}:`, err)
    throw new Error(`Failed to extract content from ${type}`)
  }
}

// ─── Image text extraction — tiered approach ──────────────────────────────────
// Tier 1 (free): Tesseract OCR — good for printed menus, price lists, clear text
// Tier 2 (paid): Claude Vision — better for complex layouts, handwriting, photos
async function extractImageText(filePath: string, hint = 'image'): Promise<string> {
  // Try Tesseract first (free, no API key needed)
  const tesseractResult = await tryTesseract(filePath)

  // If Tesseract got meaningful text (>50 chars), use it
  if (tesseractResult && tesseractResult.length > 50) {
    console.log(`[aiExtractor] Tesseract extracted ${tesseractResult.length} chars from ${path.basename(filePath)}`)
    return tesseractResult
  }

  // Tesseract failed or got little text — try Claude Vision if key is available
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    console.log(`[aiExtractor] Tesseract got little text, trying Claude Vision...`)
    return await extractImageWithVision(filePath, hint)
  }

  // No Vision key — return whatever Tesseract got or a placeholder
  if (tesseractResult) return tesseractResult
  return `[Image content from ${path.basename(filePath)} — set ANTHROPIC_API_KEY for better OCR, or install Tesseract]`
}

// ─── Tesseract OCR (free, local) ─────────────────────────────────────────────
async function tryTesseract(filePath: string): Promise<string | null> {
  try {
    // Dynamic import — tesseract is optional (npm install node-tesseract-ocr)
    const tesseract = await import('node-tesseract-ocr').catch(() => null)
    if (!tesseract) {
      // tesseract package not installed — skip silently
      return null
    }

    const text = await (tesseract as any).recognize(filePath, {
      lang: 'eng',
      oem: 1,   // LSTM neural net mode
      psm: 3,   // Automatic page segmentation
    })
    return cleanText(text)
  } catch (err) {
    // Tesseract binary not installed on system — skip silently
    console.log(`[aiExtractor] Tesseract unavailable (${(err as Error).message.slice(0, 60)})`)
    return null
  }
}

// ─── Claude Vision OCR (paid, better quality) ────────────────────────────────
async function extractImageWithVision(filePath: string, hint = 'image'): Promise<string> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return `[Image ${path.basename(filePath)} — install node-tesseract-ocr or set ANTHROPIC_API_KEY for OCR]`
  }

  try {
    const buffer = fs.readFileSync(filePath)
    const base64 = buffer.toString('base64')

    // Determine media type
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    const mediaTypeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png', webp: 'image/webp',
      gif: 'image/gif', pdf: 'image/jpeg', // PDFs converted to image fallback
    }
    const mediaType = mediaTypeMap[ext] || 'image/jpeg'

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            },
            {
              type: 'text',
              text: `Extract ALL text and useful business information from this ${hint}. 
Include: menu items with prices, business hours, contact info, services offered, policies, FAQs, descriptions — anything relevant to a business AI receptionist.
Format as clean readable text. Be thorough.`,
            },
          ],
        }],
      }),
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Claude Vision failed (${response.status}): ${err}`)
    }

    const data = await response.json() as { content: Array<{ type: string; text?: string }> }
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')

    console.log(`[aiExtractor] Vision OCR extracted ${text.length} chars from ${path.basename(filePath)}`)
    return cleanText(text)

  } catch (err) {
    console.error('[aiExtractor] Vision extraction failed:', (err as Error).message)
    return `[Image ${path.basename(filePath)} — OCR failed: ${(err as Error).message}]`
  }
}

// ─── Website scraper ──────────────────────────────────────────────────────────
async function scrapeWebsite(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'VoiceBridge-Bot/1.0 (Business Knowledge Scraper)' },
      signal: AbortSignal.timeout(15000),
    })

    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const html = await response.text()

    // Strip scripts, styles, nav, footer — keep content
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
      .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
      .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
      .slice(0, 50000)

    console.log(`[aiExtractor] Scraped ${text.length} chars from ${url}`)
    return `[Content from ${url}]\n\n${text}`

  } catch (err) {
    console.error(`[aiExtractor] Scraping failed for ${url}:`, err)
    return `[Failed to scrape ${url} — ${(err as Error).message}]`
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function cleanText(text: string): string {
  return text
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, 50000)
}
