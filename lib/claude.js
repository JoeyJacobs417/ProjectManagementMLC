// PDF parsing via Anthropic Claude. Geeft gestructureerde JSON terug.
import Anthropic from '@anthropic-ai/sdk';
import pdf from 'pdf-parse/lib/pdf-parse.js';

const SYSTEM = `Je bent een assistent die projectvoorstellen/offertes leest en informatie extraheert.
Je antwoordt UITSLUITEND in geldig JSON, zonder uitleg eromheen en zonder code-fences.`;

function userPrompt(text) {
  return `Hieronder staat de tekst van een project-PDF (offerte of voorstel).
Haal de volgende informatie eruit:

- "available_hours": totaal aantal beschikbare uren (getal, anders 0)
- "hourly_rate": uurtarief in euro (getal, anders 0)
- "description": korte beschrijving van wat we voor de klant doen (max 3 zinnen)
- "exceptions": uitzonderingen / kortingen / bijzondere afspraken (lege string als niets)
- "phases": lijst van fases, elk met "name", "description", "hours"

Antwoord met JSON in exact deze structuur. Onbekend = 0 of leeg.

PDF-tekst:
"""
${text}
"""`;
}

export async function extractPdfText(buffer) {
  const data = await pdf(buffer);
  return (data.text || '').trim();
}

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

export async function parseProjectPdf(buffer) {
  const text = await extractPdfText(buffer);
  if (!text) {
    return {
      available_hours: 0,
      hourly_rate: 0,
      description: '',
      exceptions: '',
      phases: [],
    };
  }

  const trimmed = text.length > 60000 ? text.slice(0, 60000) : text;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';

  const msg = await client.messages.create({
    model,
    max_tokens: 2048,
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt(trimmed) }],
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
