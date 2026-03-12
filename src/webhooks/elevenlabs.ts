import { Router, Request, Response } from 'express'
import prisma from '../lib/prisma.js'

const router = Router()

/**
 * ElevenLabs Conversational AI Webhook
 * Receives call events: call_started, call_ended, transcript_available
 * Configure this URL in your ElevenLabs agent settings
 */
router.post('/', async (req: Request, res: Response) => {
  res.status(200).json({ received: true })

  try {
    const event = JSON.parse((req.body as Buffer).toString()) as {
      type:         string
      agent_id:     string
      conversation_id: string
      call_duration_secs?: number
      transcript?:  Array<{ role: string; message: string }>
      caller_id?:   string
      metadata?:    Record<string, unknown>
    }

    console.log(`[ElevenLabs Webhook] Event: ${event.type} | Agent: ${event.agent_id}`)

    // Find business by agentId
    const business = await prisma.business.findFirst({
      where: { agentId: event.agent_id },
    })
    if (!business) return

    if (event.type === 'conversation_initiation_metadata') {
      // New call started — create call record
      await prisma.call.create({
        data: {
          businessId:       business.id,
          callerNumber:     event.caller_id || 'Unknown',
          status:           'COMPLETED', // will update on end
          elevenlabsCallId: event.conversation_id,
          language:         business.primaryLanguage,
        },
      })
    }

    if (event.type === 'conversation_ended' || event.type === 'call_ended') {
      const transcript = event.transcript
        ? event.transcript.map(t => `${t.role === 'agent' ? 'Agent' : 'Caller'}: ${t.message}`).join('\n')
        : null

      await prisma.call.updateMany({
        where: { elevenlabsCallId: event.conversation_id },
        data:  {
          duration:   event.call_duration_secs || null,
          transcript: transcript || null,
          endedAt:    new Date(),
          status:     'COMPLETED',
        },
      })

      console.log(`[ElevenLabs] Call ended: ${event.conversation_id} — ${event.call_duration_secs}s`)
    }

    if (event.type === 'agent_response') {
      // Could use for real-time monitoring — skip for now
    }
  } catch (err) {
    console.error('[ElevenLabs Webhook] Error:', err)
  }
})

export default router
