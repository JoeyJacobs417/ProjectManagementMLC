// POST /api/projects/parse-pdf
//   - zonder query: parse PDF + sla op onder pending-token (voor nieuw project)
//   - ?project_id=X: parse PDF + sla op direct op bestaand project (vervangt evt. oude)
import crypto from 'node:crypto';
import busboy from 'busboy';
import { Redis } from '@upstash/redis';
import { requireUser } from '../../lib/auth.js';
import { parseProjectPdf } from '../../lib/claude.js';
import { getProject, saveProject, savePdfBlob } from '../../lib/db.js';
import { logActivity } from '../../lib/activity.js';

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

  const targetProjectId = req.query.project_id ? String(req.query.project_id) : null;
  let targetProject = null;
  if (targetProjectId) {
    targetProject = await getProject(targetProjectId);
    if (!targetProject) {
      res.status(404).json({ error: 'Project niet gevonden' });
      return;
    }
    if (user.role !== 'admin' && targetProject.manager_id !== user.id) {
      res.status(403).json({ error: 'Geen toegang' });
      return;
    }
  }

  try {
    const { buffer, filename, fields } = await readFormData(req);
    const parsed = await parseProjectPdf(buffer, { userPrompt: fields.prompt });

    if (targetProject) {
      // Direct opslaan onder bestaand project (vervangt oude)
      const base64 = buffer.toString('base64');
      await savePdfBlob(targetProject.id, base64, filename, 'application/pdf');
      targetProject.pdf_stored = true;
      targetProject.source_pdf_filename = filename;
      logActivity(targetProject, user, 'pdf_uploaded', { filename });
      await saveProject(targetProject);
      res.status(200).json({
        ...parsed,
        source_pdf_filename: filename,
        attached_to_project: targetProject.id,
      });
      return;
    }

    // Nieuw project flow: sla op onder pending-token
    const token = crypto.randomBytes(12).toString('hex');
    const base64 = buffer.toString('base64');
    await kv.set(
      `pdf:_pending:${token}`,
      { base64, filename, mime: 'application/pdf', saved_at: new Date().toISOString() },
      { ex: 60 * 60 }
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
