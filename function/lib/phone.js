/**
 * lib/phone.js — Normalisasi & dedup nomor HP
 * =============================================
 * Keputusan bisnis (dikonfirmasi): identitas "customer" = nomor HP yang
 * dipakai saat memesan. Fallback ke customer_id kalau HP tidak ketemu.
 * Kalau keduanya tidak ketemu -> customer baru.
 *
 * WAJIB dipanggil sebelum matching apa pun. Data asli terbukti punya
 * variasi panjang 11-14 digit termasuk nomor yang kehilangan kode negara
 * (contoh nyata: "82138584894" seharusnya "6282138584894").
 */

function normalizePhone(raw) {
  if (!raw) return { normalized: null, valid: false, reason: 'empty' };

  let digits = String(raw).replace(/\D/g, '');

  if (digits.startsWith('0')) {
    digits = '62' + digits.slice(1);
  } else if (digits.startsWith('8') && !digits.startsWith('62')) {
    digits = '62' + digits;
  } else if (!digits.startsWith('62')) {
    return { normalized: digits, valid: false, reason: 'no_country_code_pattern' };
  }

  if (digits.length < 11 || digits.length > 15) {
    return { normalized: digits, valid: false, reason: 'length_out_of_range' };
  }

  return { normalized: digits, valid: true, reason: null };
}

/**
 * Tentukan status customer: LAMA (match by phone), LAMA (fallback by
 * customer_id, HP kemungkinan ganti), atau BARU.
 *
 * @param {string} phoneRaw
 * @param {string} customerIdSource - customer_id dari Trx Baus/Olsera
 * @param {object} db - Firestore instance
 * @returns {Promise<{status:'existing'|'existing_via_id_fallback'|'new', phoneKey:string, existingDocId?:string}>}
 */
async function resolveCustomer(phoneRaw, customerIdSource, db) {
  const { normalized, valid, reason } = normalizePhone(phoneRaw);

  if (!valid) {
    // tetap lanjut tapi ditandai perlu review manual - jangan diam-diam dibuang
    return {
      status: 'needs_review',
      phoneKey: normalized,
      reason,
    };
  }

  const byPhone = await db.collection('customers').doc(normalized).get();
  if (byPhone.exists) {
    return { status: 'existing', phoneKey: normalized, existingDocId: normalized };
  }

  if (customerIdSource) {
    const byIdQuery = await db
      .collection('customers')
      .where('customer_id_source', '==', customerIdSource)
      .limit(1)
      .get();

    if (!byIdQuery.empty) {
      const existingDoc = byIdQuery.docs[0];
      // HP kemungkinan ganti - customer lama, phone baru dicatat sebagai alias
      return {
        status: 'existing_via_id_fallback',
        phoneKey: normalized,
        existingDocId: existingDoc.id,
      };
    }
  }

  return { status: 'new', phoneKey: normalized };
}

module.exports = { normalizePhone, resolveCustomer };
