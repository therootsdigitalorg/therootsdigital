'use strict';
/* KYB / KYC verification documents (ID card or passport per owner, company registration such as an LLC certificate,
   proof of business address, …).

   - Files are validated by content (magic bytes), not by name: PDF, JPEG, PNG or WebP, max 3 MB (fits Vercel's 4.5 MB
     request limit after base64).
   - Stored ENCRYPTED at rest (AES-256-GCM with APP_ENCRYPTION_KEY) and never included in list responses.
   - A merchant sees only its own documents; staff need merchants.manage to view or review them, and every staff view is
     written to the audit trail.
   - Approval of a merchant requires every required document to be verified (see requirements()). */
const store = require('./db');
const U = require('./util');
const core = require('./core');
const { HttpError, bad, id } = U;

const TYPES = {
  owner_id: { label: 'Owner ID card or passport', perOwner: true, required: true, hint: 'Front of a valid government ID or the passport photo page, for each owner with 25%+.' },
  company_registration: { label: 'Company registration (LLC / incorporation certificate)', required: true, hint: 'Certificate of incorporation / LLC formation, or trade licence.' },
  proof_of_address: { label: 'Proof of business address', required: true, hint: 'Utility bill, bank statement or lease, issued in the last 3 months.' },
  tax_document: { label: 'Tax registration (EIN / NTN / VAT)', required: false, hint: 'Optional, but speeds up review.' },
  ownership_structure: { label: 'Ownership structure / shareholder register', required: false, hint: 'Required if owners hold shares through another company.' },
  other: { label: 'Other supporting document', required: false, hint: 'Anything compliance asked you for.' },
};
const MAX_BYTES = 3 * 1024 * 1024;
const MIME = {
  'application/pdf': b => b.subarray(0, 5).toString('latin1') === '%PDF-',
  'image/jpeg': b => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': b => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': b => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
};
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

const publicDoc = d => ({ id: d.id, type: d.type, label: TYPES[d.type]?.label || d.type, owner_index: d.owner_index ?? null, filename: d.filename, content_type: d.content_type, size: d.size,
  sha256: d.sha256, status: d.status, review: d.review || null, uploaded_by: d.uploaded_by, created: d.created_at });

/** Validate and store an upload. input: { type, owner_index, filename, content_type, data (base64) } */
function upload(m, input, actor) {
  const type = String(input.type || '');
  if (!TYPES[type]) throw bad('Choose a document type.', 'document_type_invalid');
  let ownerIndex = null;
  if (TYPES[type].perOwner) {
    ownerIndex = Number(input.owner_index);
    if (!Number.isInteger(ownerIndex) || !m.kyb.owners[ownerIndex]) throw bad('Choose which owner this ID belongs to (add owners first).', 'owner_invalid');
  }
  const b64 = String(input.data || '').replace(/^data:[^,]*,/, '');
  if (!b64 || !/^[A-Za-z0-9+/=\s]+$/.test(b64)) throw bad('The file could not be read. Try again.', 'file_invalid');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw bad('The file is empty.', 'file_invalid');
  if (buf.length > MAX_BYTES) throw bad('Files must be 3 MB or smaller. Scan at a lower resolution or export as compressed PDF/JPEG.', 'file_too_large');
  const ct = Object.keys(MIME).find(k => MIME[k](buf)); // trust the bytes, not the browser's label
  if (!ct) throw bad('Only PDF, JPEG, PNG or WebP files are accepted.', 'file_type_invalid');
  const filename = U.str(input.filename, 120).replace(/[^\w.\- ()]/g, '_') || `${type}.${EXT[ct]}`;
  return store.tx(() => {
    // a new upload of the same slot replaces the previous (unless already verified)
    for (const old of store.list('documents', { merchant_id: m.id }, { limit: 500 })) {
      if (old.type === type && (old.owner_index ?? null) === ownerIndex && ['pending', 'rejected'].includes(old.status) && type !== 'other') { old.status = 'superseded'; store.put('documents', old); }
    }
    const d = store.put('documents', { id: id('doc'), merchant_id: m.id, k: U.sha256(buf), status: 'pending', type, owner_index: ownerIndex, filename, content_type: ct, size: buf.length,
      sha256: U.sha256(buf), data: U.seal(buf.toString('base64')), uploaded_by: actor });
    core.audit(actor, 'document.upload', d.id, `${type}${ownerIndex != null ? ' #' + ownerIndex : ''} · ${filename} · ${buf.length} B`, m.id);
    return d;
  });
}
function file(d) { return { buffer: Buffer.from(U.unseal(d.data), 'base64'), type: d.content_type, name: d.filename }; }
function review(d, status, note, actor) {
  if (!['verified', 'rejected'].includes(status)) throw bad('Status must be verified or rejected.');
  if (d.status === 'superseded') throw bad('A newer upload replaced this document.');
  if (status === 'rejected' && U.str(note, 300).length < 3) throw bad('Tell the merchant why (shown to them).');
  d.status = status; d.review = { by: actor, at: Date.now(), note: U.str(note, 300) }; store.put('documents', d);
  // owner IDs drive the owner's KYC status
  if (d.type === 'owner_id' && d.owner_index != null) {
    const m = core.merchant(d.merchant_id), o = m.kyb.owners[d.owner_index];
    if (o) { o.idStatus = status === 'verified' ? 'verified' : 'rejected'; m.kyb.checks.owners = m.kyb.owners.length > 0 && m.kyb.owners.every(x => x.idStatus === 'verified'); store.put('merchants', m); }
  }
  if (d.type === 'company_registration' && status === 'verified') { const m = core.merchant(d.merchant_id); m.kyb.checks.registration = true; store.put('merchants', m); }
  core.audit(actor, 'document.' + status, d.id, `${d.type} · ${d.review.note}`, d.merchant_id);
  return d;
}
function remove(d, actor) {
  if (d.status === 'verified') throw bad('Verified documents cannot be deleted. Upload a replacement and ask compliance to review it.');
  d.status = 'superseded'; d.data = null; store.put('documents', d); core.audit(actor, 'document.delete', d.id, d.type, d.merchant_id);
  return d;
}
/** Required-document checklist for a merchant (current, non-superseded uploads). */
function requirements(m) {
  const docs = store.list('documents', { merchant_id: m.id }, { limit: 500 }).filter(d => d.status !== 'superseded');
  const slot = (type, owner) => docs.filter(d => d.type === type && (owner == null || d.owner_index === owner));
  const state = list => list.some(d => d.status === 'verified') ? 'verified' : list.some(d => d.status === 'pending') ? 'pending' : list.some(d => d.status === 'rejected') ? 'rejected' : 'missing';
  const items = [];
  for (const [type, t] of Object.entries(TYPES)) {
    if (!t.required) continue;
    if (t.perOwner) { if (!m.kyb.owners.length) items.push({ type, owner_index: null, label: `${t.label} — add owners first`, status: 'missing' }); m.kyb.owners.forEach((o, i) => items.push({ type, owner_index: i, label: `${t.label} — ${o.name}`, status: state(slot(type, i)) })); }
    else items.push({ type, owner_index: null, label: t.label, status: state(slot(type)) });
  }
  return { items, complete: items.length > 0 && items.every(i => i.status === 'verified'), documents: docs.map(publicDoc) };
}

module.exports = { TYPES, MAX_BYTES, publicDoc, upload, file, review, remove, requirements };
