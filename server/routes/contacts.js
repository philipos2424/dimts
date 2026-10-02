import express from 'express';
import { query, queryOne } from '../db/pool.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { deleteContact } from '../services/delete-account.js';
import { audit } from '../lib/audit.js';

export const contactsRouter = express.Router();
const escape = (text) => String(text ?? '').replace(/\\/g, '\\\\')
  .replace(/\r?\n|\r/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
export function contactVCard(contact) {
  return ['BEGIN:VCARD', 'VERSION:3.0', `FN:${escape(contact.display_name || contact.phone)}`,
    `TEL;TYPE=CELL:${escape(contact.phone)}`, `ORG:${escape(contact.company)}`,
    `NOTE:${escape(contact.notes)}`, 'END:VCARD', ''].join('\r\n');
}
contactsRouter.get('/', async (req, res) => {
  const user = await resolveUser(req);
  const { rows } = await query(`SELECT id, phone, display_name, company, notes, name_source, last_call_at
    FROM contacts WHERE user_id = $1 ORDER BY last_call_at DESC NULLS LAST, first_seen_at DESC LIMIT 250`, [user.id]);
  res.json({ contacts: rows });
});
contactsRouter.patch('/:id', async (req, res) => {
  const user = await resolveUser(req);
  const { display_name, company = '', notes = '' } = req.body ?? {};
  if (typeof display_name !== 'string' || !display_name.trim() || display_name.length > 100 ||
      typeof company !== 'string' || company.length > 200 || typeof notes !== 'string' || notes.length > 5000) {
    throw new HttpError(400, 'invalid_contact', 'Enter a name and keep notes under 5000 characters.');
  }
  const row = await queryOne(`UPDATE contacts SET display_name = $3, company = $4,
    notes = $5, name_source = 'user' WHERE id = $1 AND user_id = $2
    RETURNING id, phone, display_name, company, notes, name_source, last_call_at`,
  [req.params.id, user.id, display_name.trim(), company.trim(), notes.trim()]);
  if (!row) throw new HttpError(404, 'contact_not_found');
  res.json(row);
});
contactsRouter.get('/:id/vcard', async (req, res) => {
  const user = await resolveUser(req);
  const row = await queryOne('SELECT * FROM contacts WHERE id = $1 AND user_id = $2', [req.params.id, user.id]);
  if (!row) throw new HttpError(404, 'contact_not_found');
  res.type('text/vcard').set('Content-Disposition', 'attachment; filename="contact.vcf"').send(contactVCard(row));
});

contactsRouter.delete('/:id', async (req, res) => {
  const user = await resolveUser(req);
  if (req.body?.confirm !== 'delete-contact') throw new HttpError(400, 'deletion_confirmation_required');
  if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw new HttpError(404, 'contact_not_found');
  const result = await deleteContact(user.id, req.params.id);
  await audit({ userId: user.id, action: 'contact_deleted', targetType: 'contact', targetId: req.params.id, req });
  res.json(result);
});
