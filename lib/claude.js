// PDF parsing via Claude — stuurt de PDF direct als document block naar de API.
import Anthropic from '@anthropic-ai/sdk';

const SYSTEM = `Je bent een assistent die projectvoorstellen/offertes leest en informatie extraheert.
Je antwoordt UITSLUITEND in geldig JSON, zonder uitleg eromheen en zonder code-fences.`;

const USER_TEXT = `Lees de bijgevoegde PDF (een offerte of projectvoorstel) en haal de volgende informatie eruit:

- "available_hours": totaal aantal beschikbare uren (getal, anders 0)
- "hourly_rate": uurtarief in euro (getal, anders 0)
- "description": korte beschrijving van wat we voor de klant doen (max 3 zinnen)
- "exceptions": uitzonderingen / kortingen / bijzondere afspraken (lege string als niets)
- "phases": lijst van fases, elk met "name", "description", "hours"

Antwoord met JSON in exact deze structuur. Onbekend = 0 of leeg.`;

function safeJsonExtract(raw) {
  let text = (raw || '').trim();
  if (text.startsWith('```')) {
    text = text.replace(/^```(?:json)?/i, '').trim();
    if (text.endsWith('```')) text = text.slice(0, -3).trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fallthrough */
      }
    }
  }
  return {};
}

function describeError(err) {
  // Verzamel zo veel mogelijk details voor in de logs.
  const out = {
    name: err?.name || null,
    message: err?.message || null,
    status: err?.status ?? null,
    code: err?.code || null,
    type: err?.type || null,
    cause_message: err?.cause?.message || null,
    cause_code: err?.cause?.code || null,
    error_body: err?.error || null,
  };
  return out;
}

export async function parseProjectPdf(buffer) {
  if (!buffer || buffer.length === 0) {
    return {
      available_hours: 0,
      hourly_rate: 0,
      description: '',
      exceptions: '',
      phases: [],
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY ontbreekt in environment variables');
  }
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const base64 = buffer.toString('base64');

  const client = new Anthropic({
    apiKey,
    timeout: 55_000, // iets korter dan Vercel function timeout (60s)
    maxRetries: 1,
  });

  console.log('Claude PDF parse start', {
    model,
    pdf_bytes: buffer.length,
    base64_chars: base64.length,
  });

  let msg;
  try {
    msg = await client.messages.create({
      model,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64,
              },
            },
            { type: 'text', text: USER_TEXT },
          ],
        },
      ],
    });
  } catch (err) {
    const detail = describeError(err);
    console.error('Claude API error', detail);
    const reason =
      err?.error?.error?.message ||
      err?.cause?.message ||
      err?.message ||
      String(err);
    throw new Error(`Claude API (${detail.name || 'error'}${detail.status ? ' ' + detail.status : ''}): ${reason}`);
  }

  console.log('Claude PDF parse OK', {
    stop_reason: msg.stop_reason,
    in_tokens: msg.usage?.input_tokens,
    out_tokens: msg.usage?.output_tokens,
  });

  let raw = '';
  for (const block of msg.content || []) {
    if (block.type === 'text') raw += block.text;
  }
  const data = safeJsonExtract(raw);

  return {
    available_hours: Number(data.available_hours) || 0,
    hourly_rate: Number(data.hourly_rate) || 0,
    description: String(data.description || '').trim(),
    exceptions: String(data.exceptions || '').trim(),
    phases: Array.isArray(data.phases)
      ? data.phases
          .filter((p) => p && typeof p === 'object')
          .map((p) => ({
            name: String(p.name || '').trim(),
            description: String(p.description || '').trim(),
            hours: Number(p.hours) || 0,
          }))
      : [],
  };
}
