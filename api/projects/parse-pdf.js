// POST /api/projects/parse-pdf — multipart upload van PDF, parse via Claude.
// Slaat de PDF tijdelijk op onder pdf:_pending:<token>, frontend krijgt token mee om later
// te koppelen aan een project (zie POST /api/projects).
import crypto from 'node:crypto';
import busboy from 'busboy';
import { requireUser } from '../../lib/auth.js';
import { parseProjectPdf } from '../../lib/claude.js';
import { Redis } from '@upstash/redis';

const kv = Redis.fromEnv();

export const config = {
  api: {
    bodyParser: false,
  },
};

function readFormData(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });
    const chunks = [];
    const fields = {};
    let filename = null;
    let tooBig = false;

    bb.on('file', (_name, file, info) => {
      filename = info.filename;
      file.on('data', (d) => chunks.push(d));
      file.on('limit', () => { tooBig = true; });
      file.on('end', () => {});
    });
    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('finish', () => {
      if (tooBig) return reject(new Error('Bestand te groot (>25MB)'));
      if (chunks.length === 0) return reject(new Error('Geen bestand ontvangen'));
      resolve({ buffer: Buffer.concat(chunks), filename, fields });
    });
    bb.on('error', reject);
    req.pipe(bb);
  });
}

export default async function handler(req, res) {
  const user = await requireUser(req, res);
  if (!user) return;
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  try {
    const { buffer, filename, fields } = await readFormData(req);
    const userPrompt = fields.prompt;
    const parsed = await parseProjectPdf(buffer, { userPrompt });

    // Sla de PDF tijdelijk op zodat 'ie aan het project gekoppeld kan worden na opslaan
    const token = crypto.randomBytes(12).toString('hex');
    const base64 = buffer.toString('base64');
    await kv.set(
      `pdf:_pending:${token}`,
      { base64, filename, mime: 'application/pdf', saved_at: new Date().toISOString() },
      { ex: 60 * 60 } // 1 uur TTL — daarna verlopen als er geen project van is gemaakt
    );

    res.status(200).json({
      ...parsed,
      source_pdf_filename: filename,
      pdf_pending_token: token,
    });
  } catch (err) {
    res.status(400).json({ error: err.message || 'PDF kon niet verwerkt worden' });
  }
}
