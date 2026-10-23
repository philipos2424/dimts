import express from 'express';
import { query, queryOne } from '../db/pool.js';
import { HttpError, resolveUser } from '../lib/users.js';
import { deleteContact } from '../services/delete-account.js';
import { audit } from '../lib/audit.js';
import { listPromises } from './promises.js';
import { sealText } from '../lib/field-crypto.js';

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
  const { rows } = await query(`SELECT id, phone, display_name, company, notes, name_source, last_call_at, recording_pref
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
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) throw new HttpError(404, 'contact_not_found');
  const row = await queryOne(`UPDATE contacts SET display_name = $3, company = $4,
    notes = $5, name_source = 'user' WHERE id = $1 AND user_id = $2
    RETURNING id, phone, display_name, company, notes, name_source, last_call_at, recording_pref`,
  [req.params.id, user.id, display_name.trim(), company.trim(),
    notes.trim() ? sealText(notes.trim(), { userId: user.id, rowId: req.params.id, field: 'contacts:notes' }) : '']);
  if (!row) throw new HttpError(404, 'contact_not_found');
  res.json(row);
});
contactsRouter.patch('/:id/recording', async (req, res) => {
  const user = await resolveUser(req);
  const pref = req.body?.recording_pref;
  if (!['default', 'record', 'skip'].includes(pref)) throw new HttpError(400, 'invalid_recording_pref');
  const row = await queryOne('UPDATE contacts SET recording_pref=$3 WHERE id=$1 AND user_id=$2 RETURNING id, recording_pref',
    [req.params.id, user.id, pref]);
  if (!row) throw new HttpError(404, 'contact_not_found');
  await audit({ userId: user.id, action: 'contact_recording_changed', targetType: 'contact', targetId: row.id, req });
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

// Person page. Non-UUID paths fall through to other routers (e.g. /contacts/context).
contactsRouter.get('/:id', async (req, res, next) => {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.params.id)) return next();
  const user = await resolveUser(req);
  const contact = await queryOne(`SELECT id, phone, display_name, company, notes, name_source, last_call_at, recording_pref
    FROM contacts WHERE id=$1 AND user_id=$2`, [req.params.id, user.id]);
  if (!contact) throw new HttpError(404, 'contact_not_found');
  const { rows: calls } = await query(`SELECT id, created_at, direction, status, duration_sec, summary, agreements
    FROM calls WHERE user_id=$1 AND contact_id=$2 AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 50`, [user.id, contact.id]);
  res.json({ contact, calls, promises: await listPromises(user.id, contact.id) });
});
