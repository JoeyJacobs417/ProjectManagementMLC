// POST /api/projects/parse-pdf — multipart upload van PDF, parse via Claude.
import busboy from 'busboy';
import { requireUser } from '../../lib/auth.js';
import { parseProjectPdf } from '../../lib/claude.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

function readFile(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 25 * 1024 * 1024 } });
    const chunks = [];
    let filename = null;
    let tooBig = false;

    bb.on('file', (_name, file, info) => {
      filename = info.filename;
      file.on('data', (d) => chunks.push(d));
      file.on('limit', () => {
        tooBig = true;
      });
      file.on('end', () => {});
    });
    bb.on('finish', () => {
      if (tooBig) return reject(new Error('Bestand te groot (>25MB)'));
      if (chunks.length === 0) return reject(new Error('Geen bestand ontvangen'));
      resolve({ buffer: Buffer.concat(chunks), filename });
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
    const { buffer, filename } = await readFile(req);
    const parsed = await parseProjectPdf(buffer);
    res.status(200).json({ ...parsed, source_pdf_filename: filename });
  } catch (err) {
    res.status(400).json({ error: err.message || 'PDF kon niet verwerkt worden' });
  }
}
