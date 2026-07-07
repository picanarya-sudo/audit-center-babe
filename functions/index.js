/**
 * functions/index.js — Cloud Function inti Audit Center
 * =======================================================
 *
 * DUA TRIGGER TERPISAH DENGAN EFEK BERBEDA (sesuai keputusan):
 *
 * 1. onAuditorUpload  - trigger saat file masuk ke Storage path
 *    "auditor-uploads/{filename}". Ini upload harian data transaksi Baus.
 *    Efek: update customers + orders + BIKIN task audit baru.
 *
 * 2. onBrandBulkUpload - trigger saat file masuk ke Storage path
 *    "brand-uploads/{filename}". Ini seed/backfill histori dari database
 *    lama (format Rincian Penjualan, sudah ada net_amount/product_cost
 *    langsung, TIDAK perlu matching SKU). Efek: update customers + orders
 *    SAJA - TIDAK membuat task audit, sesuai permintaan eksplisit.
 *
 * BELUM DIKERJAKAN DI FILE INI (masih perlu diputuskan/ditambah):
 *   - Cloud Function terjadwal untuk menjalankan evaluateChurnStatus per
 *     customer tiap awal bulan (bisa pakai Cloud Scheduler + Pub/Sub).
 *   - Endpoint upload SKU cost bulk-update (functions/skuUpload.js, belum
 *     ditulis - polanya sama seperti onBrandBulkUpload).
 *   - Auth middleware nyata (contoh di bawah pakai placeholder role check,
 *     harus diganti dengan custom claims Firebase Auth asli).
 */

const functions = require('firebase-functions');
const admin = require('firebase-admin');
const XLSX = require('xlsx'); // baca .xlsx MAUPUN .csv - lihat catatan di bawah

const { resolveCustomer } = require('./lib/phone');
const { calculateOrderMargin, buildSkuCostMap, normalizeName } = require('./lib/margin');
const { evaluateChurnStatus, buildContinuousMonthlyHistory } = require('./lib/churn');

admin.initializeApp();
const db = admin.firestore();
const bucket = admin.storage().bucket();

const HIGH_MARGIN_THRESHOLD = 250000; // proxy lama, GANTI ke margin asli begitu skuCostMap terisi penuh
const HIGH_QTY_THRESHOLD = 6;

/**
 * Baca file (xlsx ATAU csv) dari Storage jadi array of objects.
 * Kenapa ganti dari csv-parse ke library xlsx: data historis dan SKU cost
 * yang kamu punya nyatanya berbentuk .xlsx (export Excel), bukan .csv murni.
 * csv-parse tidak bisa baca binary Excel sama sekali - kemungkinan besar
 * itu penyebab data historis "hilang" padahal file sukses ter-upload.
 */
async function readSpreadsheetFromStorage(fileName) {
  const [fileContents] = await bucket.file(fileName).download();
  const workbook = XLSX.read(fileContents, { type: 'buffer' });
  const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
}

// ============================================================
// TRIGGER 1: Upload harian oleh Auditor (Baus format, buat task)
// ============================================================
/**
 * Firestore membatasi maksimal 500 operasi per batch write. File besar
 * (ratusan/ribuan baris x 2 dokumen per baris) gampang melebihi ini kalau
 * ditulis dalam satu batch - begitu limitnya kelewat, SELURUH batch gagal,
 * bukan cuma sebagian. Helper ini mengumpulkan operasi lalu commit
 * bertahap tiap `chunkSize` operasi, supaya file besar tidak gagal total.
 */
class ChunkedBatchWriter {
  constructor(db, chunkSize = 400) {
    this.db = db;
    this.chunkSize = chunkSize;
    this.currentBatch = db.batch();
    this.opsInCurrentBatch = 0;
    this.totalOpsCommitted = 0;
  }
  async set(ref, data, options) {
    this.currentBatch.set(ref, data, options);
    this.opsInCurrentBatch++;
    if (this.opsInCurrentBatch >= this.chunkSize) {
      await this.currentBatch.commit();
      this.totalOpsCommitted += this.opsInCurrentBatch;
      this.currentBatch = this.db.batch();
      this.opsInCurrentBatch = 0;
    }
  }
  async commitAll() {
    if (this.opsInCurrentBatch > 0) {
      await this.currentBatch.commit();
      this.totalOpsCommitted += this.opsInCurrentBatch;
      this.opsInCurrentBatch = 0;
    }
    return this.totalOpsCommitted;
  }
}

exports.onAuditorUpload = functions.runWith({ timeoutSeconds: 540, memory: '512MB' }).region('asia-southeast2').storage.object().onFinalize(async (object) => {
  if (!object.name.startsWith('auditor-uploads/')) return null;

  const rows = await readSpreadsheetFromStorage(object.name);

  // muat SKU cost map (perlu di-cache di production, jangan query tiap invocation)
  const skuSnapshot = await db.collection('sku_costs').get();
  const skuRows = skuSnapshot.docs.map((d) => d.data());
  const skuCostMap = buildSkuCostMap(skuRows);

  const batch = new ChunkedBatchWriter(db);
  let processedCount = 0;
  let newCustomerCount = 0;
  let needsReviewCount = 0;

  for (const row of rows) {
    const resolution = await resolveCustomer(row.customer_phone, row.customer_id, db);

    if (resolution.status === 'needs_review') {
      needsReviewCount++;
      // tetap diproses tapi ditandai, JANGAN di-skip diam-diam
    }
    if (resolution.status === 'new') newCustomerCount++;

    const customerDocId = resolution.existingDocId || resolution.phoneKey;
    const customerRef = db.collection('customers').doc(customerDocId);

    const marginResult = calculateOrderMargin(
      row.order_items,
      parseFloat(row.total_nominal || 0),
      skuCostMap
    );

    // upsert order by order_no -> idempotent, aman untuk CSV yang tumpang tindih
    const orderRef = db.collection('orders').doc(row.order_no);
    await batch.set(
      orderRef,
      {
        order_no: row.order_no,
        customer_doc_id: customerDocId,
        outlet_name: row.outlet_name,
        status: row.status,
        delivery_type: row.delivery_type,
        total_quantity: parseInt(row.total_quantity || 0, 10),
        total_nominal: parseFloat(row.total_nominal || 0),
        margin: marginResult.margin,
        margin_is_partial: marginResult.isPartial, // true = ada item belum matched, review manual
        is_late_arrival: row.is_late_arrival === 'true',
        created_at: row.created_at,
        source_upload: object.name,
        ingested_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await batch.set(
      customerRef,
      {
        phone_normalized: resolution.phoneKey,
        phone_needs_review: resolution.status === 'needs_review',
        customer_id_source: row.customer_id,
        customer_name: row.customer_name,
        last_order_at: row.created_at,
        last_seen_upload: object.name,
        total_spend: admin.firestore.FieldValue.increment(parseFloat(row.total_nominal || 0)),
        total_margin: admin.firestore.FieldValue.increment(marginResult.margin),
        total_orders: admin.firestore.FieldValue.increment(1),
      },
      { merge: true }
    );

    // Task audit HANYA dibuat di jalur ini (auditor), tidak pernah di brand bulk upload
    const priority = computePriority(row, resolution.status === 'new');
    if (priority !== 'low_no_task_needed_skip') {
      const auditRef = db.collection('audits').doc(customerDocId);
      await batch.set(
        auditRef,
        {
          customer_doc_id: customerDocId,
          // Denormalisasi field tampilan supaya Auditor App tidak perlu
          // fetch dokumen customer terpisah tiap render list (N+1 reads
          // di skala 40rb+ customer itu mahal dan lambat).
          customer_name: row.customer_name,
          customer_phone: resolution.phoneKey,
          priority,
          status: 'pending', // auditor belum isi form
          created_from_order: row.order_no,
          last_order_nominal: parseFloat(row.total_nominal || 0),
          updated_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    processedCount++;
  }

  await batch.commitAll();

  functions.logger.info('onAuditorUpload selesai', {
    file: object.name,
    processedCount,
    newCustomerCount,
    needsReviewCount,
  });

  return null;
});

// ============================================================
// TRIGGER 2: Bulk seed oleh Tim Brand (format lama, TIDAK buat task)
// ============================================================
exports.onBrandBulkUpload = functions.runWith({ timeoutSeconds: 540, memory: '512MB' }).region('asia-southeast2').storage.object().onFinalize(async (object) => {
  if (!object.name.startsWith('brand-uploads/')) return null;

  const rows = await readSpreadsheetFromStorage(object.name);

  const batch = new ChunkedBatchWriter(db);

  for (const row of rows) {
    // format lama sudah punya margin langsung, TIDAK perlu matching SKU
    const resolution = await resolveCustomer(row['customer phone'], row['customer id'], db);
    const customerDocId = resolution.existingDocId || resolution.phoneKey;

    const orderRef = db.collection('orders').doc(row['order no']);
    await batch.set(
      orderRef,
      {
        order_no: row['order no'],
        customer_doc_id: customerDocId,
        total_nominal: parseFloat(row['net amount'] || 0),
        margin: parseFloat(row['gross profit'] || 0), // langsung dari kolom lama, bukan hasil matching
        margin_is_partial: false,
        created_at: row['order date'],
        source_upload: object.name,
        is_historical_seed: true,
        ingested_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await batch.set(
      db.collection('customers').doc(customerDocId),
      {
        phone_normalized: resolution.phoneKey,
        customer_id_source: row['customer id'],
        customer_name: row['customer name'],
        total_spend: admin.firestore.FieldValue.increment(parseFloat(row['net amount'] || 0)),
        total_margin: admin.firestore.FieldValue.increment(parseFloat(row['gross profit'] || 0)),
        total_orders: admin.firestore.FieldValue.increment(1),
      },
      { merge: true }
    );

    // TIDAK ADA batch.set ke collection('audits') di sini - sengaja,
    // sesuai permintaan: bulk seed brand tidak boleh membuat task auditor.
  }

  await batch.commitAll();
  functions.logger.info('onBrandBulkUpload selesai (seed historis, tanpa task audit)', {
    file: object.name,
    rowCount: rows.length,
  });

  return null;
});

// ============================================================
// setRole - set custom claim role LEWAT BROWSER, tanpa terminal.
// Buka URL ini di browser setelah deploy:
//   https://REGION-PROJECTID.cloudfunctions.net/setRole?email=...&role=auditor&secret=...
// GANTI ADMIN_SECRET di bawah sebelum deploy - siapa pun yang tahu
// secret ini bisa mengubah role siapa saja, jadi jangan dibagikan
// sembarangan dan jangan dipakai sebagai secret asal-asalan.
// ============================================================
const ADMIN_SECRET = "Berkahdalem00";

exports.setRole = functions.https.onRequest(async (req, res) => {
  const { email, role, secret } = req.query;

  if (secret !== ADMIN_SECRET) {
    res.status(403).send('Forbidden - parameter secret salah atau belum diisi.');
    return;
  }
  if (!email || !['auditor', 'brand'].includes(role)) {
    res.status(400).send('Format: ?email=nama@contoh.com&role=auditor|brand&secret=...');
    return;
  }

  try {
    const user = await admin.auth().getUserByEmail(email);
    await admin.auth().setCustomUserClaims(user.uid, { role });
    res.status(200).send(
      `OK - ${email} sekarang role="${role}". Suruh dia logout lalu login ulang di app supaya claim baru kebaca.`
    );
  } catch (e) {
    res.status(500).send('Error: ' + e.message + ' (pastikan user sudah dibuat dulu di Authentication > Users)');
  }
});

// ============================================================
// TRIGGER 3: Upload/update SKU cost oleh Tim Brand (BARU - sebelumnya
// cuma ditandai "belum ada" di README, sekarang dibangun).
// Path: sku-uploads/{filename}. Terima kolom "name"/"item_name" dan
// "buy_price"/"unit_cost" - cocok dengan format export product master
// (mis. file product-1_1000...xlsx yang sudah kamu pakai).
// ============================================================
exports.onSkuUpload = functions.region('asia-southeast2').storage.object().onFinalize(async (object) => {
  if (!object.name.startsWith('sku-uploads/')) return null;

  const rows = await readSpreadsheetFromStorage(object.name);
  const batch = new ChunkedBatchWriter(db);
  let count = 0;
  let skippedNoName = 0;

  for (const row of rows) {
    const itemName = row.name || row.item_name;
    const unitCost = parseFloat(row.buy_price || row.unit_cost || 0);

    if (!itemName) {
      skippedNoName++;
      continue;
    }

    // doc ID aman dari nama produk (huruf/angka saja, sisanya jadi underscore)
    const docId = normalizeName(itemName).replace(/[^a-z0-9]+/g, '_').slice(0, 140);

    await batch.set(
      db.collection('sku_costs').doc(docId),
      {
        item_name: itemName,
        unit_cost: unitCost,
        sku_code: row.sku || row.barcode || null,
        category: row.category || null,
        source_upload: object.name,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    count++;
  }

  await batch.commitAll();
  functions.logger.info('onSkuUpload selesai', {
    file: object.name,
    count,
    skippedNoName, // kalau ini besar, kemungkinan nama kolom di file tidak cocok - cek log
  });

  return null;
});

// ============================================================
// TRIGGER 4: Evaluasi Churn - BARU, sebelumnya cuma logika murni di
// lib/churn.js, sekarang benar-benar jalan menyentuh Firestore.
//
// Ada DUA cara menjalankan fungsi inti yang sama:
//   - Terjadwal otomatis tiap tanggal 2 awal bulan (evaluasi bulan yang
//     baru saja berakhir).
//   - Manual lewat URL (sama pola seperti setRole) - supaya bisa dites
//     SEKARANG, tidak perlu nunggu sebulan untuk tahu apakah ini jalan.
//
// CATATAN SKALA: fungsi ini scan SELURUH collection `orders` tiap
// dijalankan untuk mengelompokkan order per bulan per customer. Di skala
// sekarang (ratusan-ribuan order) ini aman. Di skala puluhan ribu
// customer dengan histori panjang, ini perlu dioptimasi (mis. simpan
// agregat bulanan langsung saat ingestion, bukan scan ulang tiap kali) -
// belum dikerjakan, catat sebagai pekerjaan lanjutan.
// ============================================================
async function runChurnEvaluation(evalYear, evalMonth) {
  const ordersSnapshot = await db.collection('orders').get();
  const monthlyCounts = {}; // { customerDocId: { "2026-04": count, ... } }

  for (const doc of ordersSnapshot.docs) {
    const order = doc.data();
    const customerId = order.customer_doc_id;
    if (!customerId || !order.created_at) continue;

    const date = new Date(String(order.created_at).replace(' ', 'T'));
    if (isNaN(date)) continue;

    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyCounts[customerId]) monthlyCounts[customerId] = {};
    monthlyCounts[customerId][key] = (monthlyCounts[customerId][key] || 0) + 1;
  }

  const batch = new ChunkedBatchWriter(db);
  let processed = 0;
  let skipped = 0;

  for (const [customerId, counts] of Object.entries(monthlyCounts)) {
    const months = Object.keys(counts).sort();
    const firstMonthKey = months[0];

    try {
      const history = buildContinuousMonthlyHistory(firstMonthKey, { year: evalYear, month: evalMonth }, counts);
      const result = evaluateChurnStatus(history, { year: evalYear, month: evalMonth });

      await batch.set(
        db.collection('customers').doc(customerId),
        {
          churn_status_monthly: result.isChurnBulanan,
          churn_status_biasa: result.isChurnBiasa,
          churn_month: `${evalYear}-${String(evalMonth).padStart(2, '0')}`,
          churn_evaluated_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
      processed++;
    } catch (e) {
      // customer yang bulan pertamanya SETELAH evalMonth (data belum ada
      // di bulan itu) akan gagal di sini - itu wajar, bukan error nyata.
      skipped++;
    }
  }

  const totalWritten = await batch.commitAll();
  return { processed, skipped, totalWritten, evalMonth: `${evalYear}-${String(evalMonth).padStart(2, '0')}` };
}

function getPreviousMonth() {
  const now = new Date();
  const month = now.getMonth(); // 0-indexed; bulan SEBELUM bulan berjalan
  if (month === 0) return { year: now.getFullYear() - 1, month: 12 };
  return { year: now.getFullYear(), month };
}

exports.evaluateChurnMonthlyScheduled = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .region('asia-southeast2')
  .pubsub.schedule('0 2 2 * *') // tanggal 2 tiap bulan, jam 2 pagi
  .timeZone('Asia/Jakarta')
  .onRun(async () => {
    const { year, month } = getPreviousMonth();
    const result = await runChurnEvaluation(year, month);
    functions.logger.info('evaluateChurnMonthlyScheduled selesai', result);
    return null;
  });

// Versi manual lewat browser, dilindungi ADMIN_SECRET yang sama seperti
// setRole. Bisa kasih ?year=2026&month=6 eksplisit, atau kosongkan untuk
// otomatis pakai bulan sebelumnya.
exports.triggerChurnEvaluation = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onRequest(async (req, res) => {
    const { secret, year, month } = req.query;
    if (secret !== ADMIN_SECRET) {
      res.status(403).send('Forbidden - parameter secret salah atau belum diisi.');
      return;
    }

    const evalYear = year ? parseInt(year, 10) : getPreviousMonth().year;
    const evalMonth = month ? parseInt(month, 10) : getPreviousMonth().month;

    try {
      const result = await runChurnEvaluation(evalYear, evalMonth);
      res.status(200).json(result);
    } catch (e) {
      res.status(500).send('Error: ' + e.message);
    }
  });


function computePriority(row, isNewCustomer) {
  const nominal = parseFloat(row.total_nominal || 0);
  const qty = parseInt(row.total_quantity || 0, 10);
  const late = row.is_late_arrival === 'true';
  const dtype = row.delivery_type;
  const status = row.status;

  const highMarginLateFast = nominal >= HIGH_MARGIN_THRESHOLD && late && (dtype === 'INSTANT' || dtype === 'EXPRESS');
  const canceled = status === 'Canceled';
  const highQty = qty > HIGH_QTY_THRESHOLD;
  const lateReguler = late && dtype === 'REGULER';

  if (highMarginLateFast || canceled || isNewCustomer) return 'Urgent';
  if (highQty || lateReguler) return 'Medium';
  return 'Low';
}
