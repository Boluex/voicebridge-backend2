/**
 * ElevenLabs Conversational AI Service
 */

const ELEVENLABS_API = 'https://api.elevenlabs.io/v1'

function apiKey(): string {
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set')
  return key
}

export interface BusinessForAgent {
  id: string
  name: string
  agentName: string
  agentVoiceId: string
  agentGreeting: string
  agentTone: string
  primaryLanguage: string
  category: string
  address?: string | null
  city?: string | null
  phone?: string | null
  escalationPhone?: string | null
}

function buildSystemPrompt(biz: BusinessForAgent, knowledgeContext = ''): string {
  return `You are ${biz.agentName}, the AI voice receptionist for ${biz.name}.

## Your Role
Handle ALL incoming calls for ${biz.name} — a ${biz.category.toLowerCase()} business.
You answer questions, take orders, process payments, handle complaints, and transfer calls.

## Your Personality
- Tone: ${biz.agentTone}
- Be helpful, professional, and concise
- This is a voice call — keep responses SHORT and conversational
- Never say you are an AI unless directly asked

## Business Details
- Business: ${biz.name}
- Category: ${biz.category}
- Location: ${[biz.address, biz.city].filter(Boolean).join(', ') || 'Available on request'}
- Phone: ${biz.phone || 'Available on request'}

## Business Knowledge Base
${knowledgeContext || 'No specific knowledge loaded yet. Answer based on general business type.'}

## Your Tools (call when needed)
1. lookup_catalogue — Search products/services and check availability
2. create_order — After confirming items and delivery details, create an order
3. send_payment_link — Generate Paystack payment link, send to caller email
4. check_payment_status — Verify payment completion
5. search_businesses — Find other VoiceBridge-registered businesses

## Order Flow
1. Identify what caller wants → call lookup_catalogue
2. Confirm item available → collect: name, delivery address, email
3. call create_order → call send_payment_link
4. Tell caller: "I've sent a payment link to your email"
5. Wait → call check_payment_status → confirm order

## Language
- Primary: ${biz.primaryLanguage}
- Switch language immediately if caller uses another language

## Rules
- NEVER make up prices or availability not in the knowledge base
- NEVER share other customers data
- NEVER charge without explicit caller confirmation
- Escalation number: ${biz.escalationPhone || 'not configured'}
`
}

// ─── Tool definition in correct ElevenLabs ConvAI webhook format ───────────────
function toolDef(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: string[],
  backendUrl: string,
  secret: string
) {
  return {
    type: 'webhook' as const,
    name,
    description,
    api_schema: {
      url: `${backendUrl}/api/public/${name.replace(/_/g, '-')}`,
      method: 'POST' as const,
      request_headers: {
        'x-agent-secret': secret,
        'Content-Type': 'application/json',
      },
      request_body_schema: {
        type: 'object',
        properties,
        required,
      },
    },
  }
}

// ─── Create agent ──────────────────────────────────────────────────────────────
export async function createElevenLabsAgent(
  biz: BusinessForAgent,
  knowledgeContext = ''
): Promise<{ agentId: string; phoneNumber: string | null }> {
  const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 5000}`
  const secret = process.env.AGENT_WEBHOOK_SECRET || 'vb-secret'

  const agentConfig = {
    name: `${biz.name} — VoiceBridge`,
    conversation_config: {
      agent: {
        prompt: {
          prompt: buildSystemPrompt(biz, knowledgeContext),
          llm: 'gemini-2.0-flash',
          temperature: 0.7,
          max_tokens: 300,
        },
        first_message: biz.agentGreeting,
        language: biz.primaryLanguage || 'en',
      },
      tts: {
        model_id: 'eleven_turbo_v2_5',
        voice_id: biz.agentVoiceId,
        stability: 0.5,
        similarity_boost: 0.75,
      },
      stt: {
        provider: 'deepgram',
        user_input_audio_format: 'ulaw_8000',
      },
      turn: {
        turn_timeout: 7,
        silence_end_call_timeout: 30,
      },
    },
    platform_settings: {
      auth: { enable_auth: false },
    },
    tools: [
      toolDef(
        'lookup_catalogue',
        'Search the business catalogue for items/services and check availability.',
        {
          query: { type: 'string', description: 'What the customer is looking for' },
          businessId: { type: 'string', description: 'Business ID', const: biz.id },
        },
        ['query', 'businessId'],
        backendUrl, secret
      ),
      toolDef(
        'create_order',
        'Create an order after collecting all details from the caller.',
        {
          businessId: { type: 'string', const: biz.id },
          customerName: { type: 'string', description: 'Full name of the customer' },
          customerEmail: { type: 'string', description: 'Customer email for payment link' },
          customerPhone: { type: 'string', description: 'Customer phone number' },
          deliveryAddress: { type: 'string', description: 'Full delivery address' },
          items: {
            type: 'array',
            description: 'Ordered items',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                qty: { type: 'number' },
                price: { type: 'number' },
              },
            },
          },
          callId: { type: 'string', description: 'Current call ID' },
        },
        ['businessId', 'customerName', 'items'],
        backendUrl, secret
      ),
      toolDef(
        'send_payment_link',
        "Send a Paystack payment link to the customer's email.",
        {
          orderId: { type: 'string', description: 'Order ID to generate payment for' },
          deliveryMethod: { type: 'string', enum: ['email', 'sms'] },
        },
        ['orderId'],
        backendUrl, secret
      ),
      toolDef(
        'check_payment_status',
        'Check if a payment for an order has been completed.',
        {
          orderId: { type: 'string', description: 'Order ID to check' },
        },
        ['orderId'],
        backendUrl, secret
      ),
      toolDef(
        'search_businesses',
        'Search for other registered VoiceBridge businesses.',
        {
          query: { type: 'string', description: 'Search query' },
          category: { type: 'string', description: 'Business category filter' },
          city: { type: 'string', description: 'City filter' },
        },
        ['query'],
        backendUrl, secret
      ),
    ],
  }

  console.log(`[ElevenLabs] Creating agent for "${biz.name}"...`)

  const res = await fetch(`${ELEVENLABS_API}/convai/agents/create`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(agentConfig),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`ElevenLabs agent create failed (${res.status}): ${errText}`)
  }

  const data = await res.json() as { agent_id: string }
  const agentId = data.agent_id
  console.log(`[ElevenLabs] Agent created: ${agentId} for "${biz.name}"`)

  // Attempt phone number purchase — non-fatal if it fails (requires paid plan + supported country)
  let phoneNumber: string | null = null
  try {
    phoneNumber = await purchasePhoneNumber(agentId, biz.country || 'US')
    if (phoneNumber) console.log(`[ElevenLabs] Phone ${phoneNumber} assigned to agent ${agentId}`)
  } catch (err) {
    console.warn(`[ElevenLabs] Phone purchase skipped (needs paid plan or unsupported country):`, (err as Error).message)
  }

  return { agentId, phoneNumber }
}

// ─── Update agent (after knowledge or config change) ──────────────────────────
export async function updateElevenLabsAgent(
  agentId: string,
  biz: BusinessForAgent,
  knowledgeContext = ''
): Promise<void> {
  const res = await fetch(`${ELEVENLABS_API}/convai/agents/${agentId}`, {
    method: 'PATCH',
    headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversation_config: {
        agent: {
          prompt: { prompt: buildSystemPrompt(biz, knowledgeContext) },
          first_message: biz.agentGreeting,
          language: biz.primaryLanguage || 'en',
        },
        tts: { voice_id: biz.agentVoiceId },
      },
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`ElevenLabs agent update failed (${res.status}): ${errText}`)
  }
}

// ─── Delete agent ──────────────────────────────────────────────────────────────
export async function deleteElevenLabsAgent(agentId: string): Promise<void> {
  try {
    const res = await fetch(`${ELEVENLABS_API}/convai/agents/${agentId}`, {
      method: 'DELETE',
      headers: { 'xi-api-key': apiKey() },
    })
    if (!res.ok) console.warn(`[ElevenLabs] Delete agent ${agentId} returned ${res.status}`)
  } catch (err) {
    console.error(`[ElevenLabs] Failed to delete agent ${agentId}:`, err)
  }
}

// ─── Get available voices ──────────────────────────────────────────────────────
export async function getVoiceModels() {
  const res = await fetch(`${ELEVENLABS_API}/voices`, {
    headers: { 'xi-api-key': apiKey() },
  })
  if (!res.ok) throw new Error('Failed to fetch voices')
  const data = await res.json() as {
    voices: Array<{ voice_id: string; name: string; labels?: Record<string, string> }>
  }
  return data.voices.map(v => ({
    id: v.voice_id,
    name: v.name,
    gender: v.labels?.gender || 'unknown',
    accent: v.labels?.accent || '',
    useCase: v.labels?.use_case || '',
  }))
}

// ─── Get signed widget URL ─────────────────────────────────────────────────────
export async function getAgentSignedUrl(agentId: string): Promise<string> {
  const res = await fetch(
    `${ELEVENLABS_API}/convai/conversation/get_signed_url?agent_id=${agentId}`,
    { headers: { 'xi-api-key': apiKey() } }
  )
  if (!res.ok) throw new Error('Failed to get signed URL')
  const data = await res.json() as { signed_url: string }
  return data.signed_url
}

// ─── Purchase phone number and assign to agent ────────────────────────────────
// countryCode is ISO 3166-1 alpha-2 (e.g. "US", "GB", "CA", "AU")
// ElevenLabs currently supports: US, GB, CA, AU — NOT Nigeria (NG) yet
// For Nigerian numbers use Twilio instead (see docs)
export async function purchasePhoneNumber(
  agentId: string,
  countryCode = 'US',   // override with business.country once ElevenLabs expands support
  areaCode?: string
): Promise<string | null> {
  // ElevenLabs does not yet support all countries — fall back to US if unsupported
  const supportedCountries = ['US', 'GB', 'CA', 'AU']
  const country = supportedCountries.includes(countryCode.toUpperCase())
    ? countryCode.toUpperCase()
    : 'US'

  if (country !== countryCode.toUpperCase()) {
    console.warn(`[ElevenLabs] Phone numbers not yet available for ${countryCode} — falling back to US number.`)
    console.warn('[ElevenLabs] For Nigerian/African numbers, integrate Twilio instead.')
  }

  const searchUrl = `${ELEVENLABS_API}/convai/phone-numbers/search?country=${country}${areaCode ? `&area_code=${areaCode}` : ''}`
  const searchRes = await fetch(searchUrl, { headers: { 'xi-api-key': apiKey() } })

  if (!searchRes.ok) {
    const errText = await searchRes.text()
    throw new Error(`Phone search failed (${searchRes.status}): ${errText}`)
  }

  const available = await searchRes.json() as { numbers?: Array<{ phone_number: string }> }
  if (!available.numbers?.length) {
    console.warn('[ElevenLabs] No phone numbers available in this region')
    return null
  }

  const phoneNumber = available.numbers[0].phone_number

  const purchaseRes = await fetch(`${ELEVENLABS_API}/convai/phone-numbers`, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      phone_number: phoneNumber,
      agent_id: agentId,
      label: `VoiceBridge — ${agentId}`,
    }),
  })

  if (!purchaseRes.ok) {
    const errText = await purchaseRes.text()
    throw new Error(`Phone purchase failed (${purchaseRes.status}): ${errText}`)
  }

  console.log(`[ElevenLabs] Purchased ${phoneNumber} for agent ${agentId}`)
  return phoneNumber
}
