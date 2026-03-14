import fs from 'fs'
import path from 'path'

type PdfParseResult = { text: string }
type MammothResult = { value: string }

/**
 * Extract text content from various file types.
 * Uses Anthropic Claude for image OCR and AI-powered web scraping.
 */
export async function extractAndSummarize(type: string, inputPath: string): Promise<string> {
  const ext = type.toLowerCase()

  try {
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'image'].includes(ext)) {
      return await extractImageText(inputPath)
    }

    if (ext === 'pdf') {
      try {
        const pdfParseModule = await import('pdf-parse/lib/pdf-parse.js')
        const pdfParse = (pdfParseModule as any).default || pdfParseModule
        const buffer = fs.readFileSync(inputPath)
        const data = await pdfParse(buffer) as PdfParseResult
        const text = cleanText(data.text)
        if (text.length < 100) {
          console.log('[aiExtractor] PDF has little text, trying image OCR...')
          return await extractImageText(inputPath, 'pdf')
        }
        return text
      } catch (err) {
        console.error('[aiExtractor] pdf-parse failed:', (err as Error).message)
        return `[PDF content from ${path.basename(inputPath)} — extraction failed]`
      }
    }

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

    if (['txt', 'csv'].includes(ext)) {
      return cleanText(fs.readFileSync(inputPath, 'utf-8'))
    }

    if (ext === 'xlsx') {
      try {
        const content = fs.readFileSync(inputPath, 'utf-8')
        return cleanText(content)
      } catch {
        return `[XLSX content from ${path.basename(inputPath)} — binary format, text extraction limited]`
      }
    }

    if (ext === 'url') {
      return await scrapeWebsite(inputPath)
    }

    return `[Content from ${type} file — unsupported format]`

  } catch (err) {
    console.error(`[aiExtractor] Error processing ${type}:`, err)
    throw new Error(`Failed to extract content from ${type}`)
  }
}

// ─── Image OCR: Tesseract (free) → Anthropic Claude Vision (paid) ─────────────
async function extractImageText(filePath: string, hint = 'image'): Promise<string> {
  console.log(`[aiExtractor] Image OCR starting: ${path.basename(filePath)}`)

  // Tier 1: Tesseract (free, local — works if installed and in PATH)
  const tesseractResult = await tryTesseract(filePath)
  if (tesseractResult && tesseractResult.length > 50) {
    console.log(`[aiExtractor] ✓ Tesseract succeeded: ${tesseractResult.length} chars`)
    return tesseractResult
  }

  // Tier 2: Anthropic Claude Vision
  const anthropicKey = (process.env.ANTHROPIC_API_KEY || '').trim()
  if (anthropicKey.length > 0) {
    console.log('[aiExtractor] Trying Anthropic Vision OCR...')
    return await extractImageWithAnthropic(filePath, hint, anthropicKey)
  }

  console.warn('[aiExtractor] No OCR method available. Set ANTHROPIC_API_KEY in backend .env')
  if (tesseractResult && tesseractResult.length > 0) return tesseractResult
  return `[Image ${path.basename(filePath)} — No OCR configured. Add ANTHROPIC_API_KEY to backend .env]`
}

// ─── Tesseract OCR (free, local) ──────────────────────────────────────────────
async function tryTesseract(filePath: string): Promise<string | null> {
  try {
    const tesseract = await import('node-tesseract-ocr').catch(() => null)
    if (!tesseract) {
      console.log('[aiExtractor] node-tesseract-ocr not installed — skipping')
      return null
    }
    const text = await (tesseract as any).recognize(filePath, { lang: 'eng', oem: 1, psm: 3 })
    const cleaned = cleanText(text)
    console.log(`[aiExtractor] Tesseract extracted ${cleaned.length} chars`)
    return cleaned
  } catch (err) {
    console.log(`[aiExtractor] Tesseract unavailable: ${(err as Error).message.slice(0, 80)}`)
    return null
  }
}

// ─── Anthropic Claude Vision OCR ─────────────────────────────────────────────
async function extractImageWithAnthropic(filePath: string, hint: string, apiKey: string): Promise<string> {
  try {
    const buffer = fs.readFileSync(filePath)
    const base64 = buffer.toString('base64')
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    const mediaTypeMap: Record<string, string> = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg',
      png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    }
    const mediaType = mediaTypeMap[ext] || 'image/jpeg'

    console.log(`[aiExtractor] Sending to Anthropic Vision: ${path.basename(filePath)} (${mediaType}, ${Math.round(buffer.length / 1024)}KB)`)

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(60000),
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            {
              type: 'text',
              text: `Extract ALL text and useful business information from this ${hint}. Include: menu items with prices, business hours, contact info, services offered, policies, FAQs. Format as clean readable text. Be thorough.`
            },
          ] as any, // Cast to any to bypass strict literal typing combining text and image objects
        }],
      }),
    })

    const responseText = await response.text()
    console.log(`[aiExtractor] Anthropic Vision response: ${response.status}`)

    if (!response.ok) {
      throw new Error(`Anthropic API ${response.status}: ${responseText.slice(0, 200)}`)
    }

    const data = JSON.parse(responseText) as { content: Array<{ type: string; text?: string }> }
    const text = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
    console.log(`[aiExtractor] ✓ Anthropic Vision extracted ${text.length} chars`)
    return cleanText(text)

  } catch (err) {
    console.error('[aiExtractor] Anthropic Vision failed:', (err as Error).message)
    return `[Image ${path.basename(filePath)} — OCR failed: ${(err as Error).message}]`
  }
}

// ─── Website scraper + AI extraction ─────────────────────────────────────────
async function scrapeWebsite(url: string): Promise<string> {
  try {
    console.log(`[aiExtractor] Scraping ${url}...`)
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      signal: AbortSignal.timeout(20000),
    })

    if (!response.ok) throw new Error(`HTTP ${response.status}`)

    const html = await response.text()

    // Strip noise, preserve readable text with structure
    const rawText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
      .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
      .replace(/<\/(p|div|li|tr|h[1-6]|section|article)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#\d+;/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 15000)

    console.log(`[aiExtractor] Raw scraped: ${rawText.length} chars from ${url}`)

    // Use Claude to extract structured business info from the raw text
    const anthropicKey = (process.env.ANTHROPIC_API_KEY || '').trim()
    if (anthropicKey.length > 0 && rawText.length > 100) {
      console.log('[aiExtractor] Using Claude to extract business info from scraped content...')
      return await extractBusinessInfoWithAI(url, rawText, anthropicKey)
    }

    console.log('[aiExtractor] No ANTHROPIC_API_KEY — returning raw scraped text')
    return `[Content from ${url}]\n\n${rawText}`

  } catch (err) {
    console.error(`[aiExtractor] Scraping failed for ${url}:`, err)
    return `[Failed to scrape ${url} — ${(err as Error).message}]`
  }
}

// ─── Claude-powered business info extractor ───────────────────────────────────
async function extractBusinessInfoWithAI(url: string, rawText: string, apiKey: string): Promise<string> {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: AbortSignal.timeout(30000),
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `You are extracting business information from a website to train an AI phone receptionist.

Website URL: ${url}

Raw scraped content:
${rawText}

Extract and organize ALL useful business information into clear sections. Include EVERYTHING you can find:
- Business name and description
- Products / services offered (with prices if available)
- Menu items (full menu with prices and descriptions)
- Business hours / opening times
- Location / address / delivery areas
- Contact information (phone, email, social media)
- Ordering process / how to order
- Payment methods accepted
- Delivery / pickup options and fees
- Special offers or promotions
- FAQs or policies (returns, reservations, etc.)
- Any other info useful for a customer calling in

Format as clean organized text with clear section headings. Skip sections where no info is found. Be thorough — this is what the AI receptionist will use to answer customer calls.`,
        }],
      }),
    })

    const responseText = await response.text()
    console.log(`[aiExtractor] Claude extraction response: ${response.status}`)

    if (!response.ok) {
      console.error('[aiExtractor] Claude extraction failed:', responseText.slice(0, 300))
      return `[Content from ${url}]\n\n${rawText}`
    }

    const data = JSON.parse(responseText) as { content: Array<{ type: string; text?: string }> }
    const extracted = data.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
    console.log(`[aiExtractor] ✓ Claude extracted ${extracted.length} chars from ${url}`)
    return `[Content from ${url}]\n\n${extracted}`

  } catch (err) {
    console.error('[aiExtractor] Claude extraction error:', (err as Error).message)
    return `[Content from ${url}]\n\n${rawText}`
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