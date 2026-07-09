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

/**
 * PENTING - bug nyata yang ditemukan: nomor order dari sistem lama TIDAK
 * unik lintas outlet. Contoh nyata: "OL26060400001088" muncul di file
 * Jebres DAN file Yamin, untuk transaksi customer yang BEDA TOTAL (nama,
 * tanggal, nominal semua beda). Kalau doc ID cuma pakai order_no polos,
 * outlet yang diproses belakangan akan MENIMPA data outlet lain secara
 * diam-diam - inilah yang menyebabkan jumlah transaksi jauh lebih sedikit
 * dari yang seharusnya.
 *
 * Perbaikan: doc ID gabungan nama file asli (yang sudah membawa identitas
 * outlet, mis. "KULKAS_BABE_JEBRES_...") + order_no. Nama file asli
 * diekstrak dari path Storage, membuang prefix timestamp yang ditambahkan
 * otomatis saat upload - supaya upload ULANG file yang SAMA tetap
 * ter-update (idempotent), bukan bikin dokumen baru.
 */
function extractOriginalFilename(storageObjectName) {
  const lastSegment = storageObjectName.split('/').pop();
  return lastSegment.replace(/^\d+_/, ''); // buang "1720350000000_" di depan
}

function sanitizeForDocId(s) {
  return String(s).trim().replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 300);
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
  let rowErrorCount = 0;
  const rowErrors = [];

  for (const [rowIndex, row] of rows.entries()) {
    try {
      const resolution = await resolveCustomer(row.customer_phone, row.customer_id, db);

      if (resolution.status === 'needs_review') {
        needsReviewCount++;
        // tetap diproses tapi ditandai, JANGAN di-skip diam-diam
      }
      if (resolution.status === 'new') newCustomerCount++;

      // PENTING: kalau HP kosong/tidak valid, phoneKey bisa jadi string
      // kosong - Firestore MENOLAK doc ID kosong (error "documentPath is
      // not a valid resource path"), dan itu akan menghentikan SELURUH
      // proses file kalau tidak ditangkap. Fallback pakai order_no supaya
      // baris ini tetap tercatat (ditandai untuk review), bukan bikin
      // seluruh file macet.
      let customerDocId = resolution.existingDocId || resolution.phoneKey;
      if (!customerDocId) {
        customerDocId = `unknown_phone_${sanitizeForDocId(row.order_no || rowIndex)}`;
        needsReviewCount++;
      }
      const customerRef = db.collection('customers').doc(customerDocId);

      const marginResult = calculateOrderMargin(
        row.order_items,
        parseFloat(row.total_nominal || 0),
        skuCostMap
      );

      // upsert order by order_no -> idempotent, aman untuk CSV yang tumpang tindih
      const orderNoSafe = String(row.order_no || `no_order_no_row_${rowIndex}`).trim();
      const orderRef = db.collection('orders').doc(orderNoSafe);
      await batch.set(
        orderRef,
        {
          order_no: orderNoSafe,
          customer_doc_id: customerDocId,
          outlet_name: row.outlet_name,
          status: row.status,
          delivery_type: row.delivery_type,
          total_quantity: parseInt(row.total_quantity || 0, 10),
          total_nominal: parseFloat(row.total_nominal || 0),
          margin: marginResult.margin,
          margin_is_partial: marginResult.isPartial, // true = ada item belum matched, review manual
          is_late_arrival: row.is_late_arrival === 'true',
          payment_method_name: row.payment_method_name || null,
          // QRIS WEB = satu-satunya metode bayar di web (keputusan bisnis
          // yang sudah dikonfirmasi) - dipakai untuk kategori Customer Website.
          is_web_channel: String(row.payment_method_name || '').startsWith('QRIS WEB'),
          created_at: row.created_at,
          source_upload: object.name,
          ingested_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      await batch.set(
        customerRef,
        {
          phone_normalized: resolution.phoneKey || null,
          phone_needs_review: !customerDocId.startsWith('unknown_phone_') ? resolution.status === 'needs_review' : true,
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
    } catch (rowError) {
      // SATU baris bermasalah TIDAK BOLEH menghentikan seluruh file -
      // catat errornya, lanjut ke baris berikutnya.
      rowErrorCount++;
      if (rowErrors.length < 20) {
        rowErrors.push({ rowIndex, order_no: row.order_no, error: rowError.message });
      }
    }
  }

  await batch.commitAll();

  functions.logger.info('onAuditorUpload selesai', {
    file: object.name,
    processedCount,
    newCustomerCount,
    needsReviewCount,
    rowErrorCount,
    rowErrors, // maksimal 20 contoh pertama - cek ini kalau rowErrorCount > 0
  });

  return null;
});

// ============================================================
// TRIGGER 2: Bulk seed oleh Tim Brand (format lama, TIDAK buat task)
// ============================================================
exports.onBrandBulkUpload = functions.runWith({ timeoutSeconds: 540, memory: '512MB' }).region('asia-southeast2').storage.object().onFinalize(async (object) => {
  if (!object.name.startsWith('brand-uploads/')) return null;

  const rows = await readSpreadsheetFromStorage(object.name);
  const originalFileName = extractOriginalFilename(object.name);

  const batch = new ChunkedBatchWriter(db);
  let processedCount = 0;
  let rowErrorCount = 0;
  const rowErrors = [];

  for (const [rowIndex, row] of rows.entries()) {
    try {
      // format lama sudah punya margin langsung, TIDAK perlu matching SKU
      const resolution = await resolveCustomer(row['customer phone'], row['customer id'], db);
      let customerDocId = resolution.existingDocId || resolution.phoneKey;
      if (!customerDocId) {
        // HP kosong/tidak valid -> jangan pakai string kosong sebagai doc ID
        // (Firestore menolak itu dan akan menghentikan SELURUH file kalau
        // tidak ditangkap di sini).
        customerDocId = `unknown_phone_${sanitizeForDocId(row['order no'] || rowIndex)}`;
      }

      // Doc ID gabungan nama file asli + order_no - lihat komentar di
      // extractOriginalFilename() untuk alasan kenapa order_no polos tidak aman.
      const orderNoSafe = String(row['order no'] || `no_order_no_row_${rowIndex}`).trim();
      const orderDocId = sanitizeForDocId(`${originalFileName}__${orderNoSafe}`);
      const orderRef = db.collection('orders').doc(orderDocId);
      await batch.set(
        orderRef,
        {
          order_no: orderNoSafe,
          customer_doc_id: customerDocId,
          total_nominal: parseFloat(row['net amount'] || 0),
          margin: parseFloat(row['gross profit'] || 0), // langsung dari kolom lama, bukan hasil matching
          margin_is_partial: false,
          created_at: row['order date'],
          payment_method_name: row['payment mode'] || null,
          is_web_channel: String(row['payment mode'] || '').startsWith('QRIS WEB'),
          source_upload: object.name,
          is_historical_seed: true,
          ingested_at: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      await batch.set(
        db.collection('customers').doc(customerDocId),
        {
          phone_normalized: resolution.phoneKey || null,
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
      processedCount++;
    } catch (rowError) {
      // SATU baris bermasalah TIDAK BOLEH menghentikan seluruh file.
      rowErrorCount++;
      if (rowErrors.length < 20) {
        rowErrors.push({ rowIndex, order_no: row['order no'], error: rowError.message });
      }
    }
  }

  await batch.commitAll();
  functions.logger.info('onBrandBulkUpload selesai (seed historis, tanpa task audit)', {
    file: object.name,
    rowCount: rows.length,
    processedCount,
    rowErrorCount,
    rowErrors, // maksimal 20 contoh pertama - cek ini kalau rowErrorCount > 0
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
const ADMIN_SECRET = "GANTI_DENGAN_KATA_SANDI_RAHASIA_MILIKMU_SENDIRI";

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
  let rowErrorCount = 0;

  for (const [rowIndex, row] of rows.entries()) {
    try {
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
    } catch (rowError) {
      rowErrorCount++;
      functions.logger.warn('onSkuUpload: gagal proses baris', { rowIndex, error: rowError.message });
    }
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
  const monthlyMargin = {}; // { customerDocId: { "2026-04": sum margin, ... } }
  const monthlyNominal = {}; // { customerDocId: { "2026-04": sum nominal, ... } }
  const firstOrderDate = {}; // { customerDocId: earliest created_at string }

  for (const doc of ordersSnapshot.docs) {
    const order = doc.data();
    const customerId = order.customer_doc_id;
    if (!customerId || !order.created_at) continue;

    const date = new Date(String(order.created_at).replace(' ', 'T'));
    if (isNaN(date)) continue;

    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    if (!monthlyCounts[customerId]) monthlyCounts[customerId] = {};
    if (!monthlyMargin[customerId]) monthlyMargin[customerId] = {};
    if (!monthlyNominal[customerId]) monthlyNominal[customerId] = {};

    monthlyCounts[customerId][key] = (monthlyCounts[customerId][key] || 0) + 1;
    monthlyMargin[customerId][key] = (monthlyMargin[customerId][key] || 0) + (order.margin || 0);
    monthlyNominal[customerId][key] = (monthlyNominal[customerId][key] || 0) + (order.total_nominal || 0);

    // first_order_at: dihitung ulang tiap kali fungsi ini jalan (idempotent,
    // aman diulang) - dipakai untuk kategori Akuisisi Customer Baru.
    if (!firstOrderDate[customerId] || order.created_at < firstOrderDate[customerId]) {
      firstOrderDate[customerId] = order.created_at;
    }
  }

  const batch = new ChunkedBatchWriter(db);
  let processed = 0;
  let skipped = 0;

  const yearMonthKey = `${evalYear}-${String(evalMonth).padStart(2, '0')}`;

  for (const [customerId, counts] of Object.entries(monthlyCounts)) {
    const months = Object.keys(counts).sort();
    const firstMonthKey = months[0];

    // Baca dokumen customer SEKALI di sini (bukan tiap kali app dibuka) -
    // dipakai untuk denormalisasi nama/HP ke churn_history di bawah, supaya
    // frontend tidak perlu baca dokumen customer terpisah per hasil.
    const customerSnap = await db.collection('customers').doc(customerId).get();
    const customerData = customerSnap.exists ? customerSnap.data() : {};

    // first_order_at ditulis ke dokumen customer langsung (fakta lifetime,
    // bukan per bulan) - dilakukan untuk SEMUA customer tiap fungsi ini
    // jalan, terlepas dari apakah mereka aktif di evalMonth atau tidak.
    await batch.set(
      db.collection('customers').doc(customerId),
      { first_order_at: firstOrderDate[customerId] },
      { merge: true }
    );

    try {
      const history = buildContinuousMonthlyHistory(firstMonthKey, { year: evalYear, month: evalMonth }, counts);
      const result = evaluateChurnStatus(history, { year: evalYear, month: evalMonth });

      // Simpan sebagai dokumen TERPISAH per bulan (subcollection), BUKAN
      // menimpa satu field di dokumen customer. Ini yang memungkinkan
      // filter bulan di UI benar-benar bekerja tanpa perlu re-trigger -
      // begitu satu bulan pernah dihitung, hasilnya tetap ada selamanya.
      // Sekalian simpan margin_sum & order_count BULAN INI SAJA (bukan
      // lifetime) - dipakai untuk kategori Loyal Customer & One Time Buyer.
      // customer_name/phone_normalized DIDENORMALISASI di sini supaya
      // frontend tidak perlu N+1 read per customer (itu yang bikin
      // "outstanding request" saat data sudah besar).
      await batch.set(
        db.collection('customers').doc(customerId).collection('churn_history').doc(yearMonthKey),
        {
          year_month: yearMonthKey,
          customer_name: customerData.customer_name || null,
          phone_normalized: customerData.phone_normalized || null,
          last_order_at: customerData.last_order_at || null,
          avg_margin_lifetime: customerData.total_orders ? Math.round((customerData.total_margin || 0) / customerData.total_orders) : 0,
          is_churn_bulanan: result.isChurnBulanan,
          is_churn_biasa: result.isChurnBiasa,
          lifetime_orders_at_eval: result.lifetimeOrders,
          margin_sum_this_month: monthlyMargin[customerId][yearMonthKey] || 0,
          nominal_sum_this_month: monthlyNominal[customerId][yearMonthKey] || 0,
          order_count_this_month: counts[yearMonthKey] || 0,
          is_loyal_high_margin: (monthlyMargin[customerId][yearMonthKey] || 0) >= 600000,
          is_loyal_high_count: (counts[yearMonthKey] || 0) >= 5,
          evaluated_at: admin.firestore.FieldValue.serverTimestamp(),
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
  return { processed, skipped, totalWritten, evalMonth: yearMonthKey };
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

// Dipanggil dari tombol di Brand App - verifikasi pakai Firebase Auth ID
// token (bukan lagi secret di URL). Tim brand tinggal klik tombol setelah
// login, tidak perlu tahu password rahasia atau edit URL apa pun.
// setRole di atas TETAP pakai ADMIN_SECRET karena itu dipakai SEBELUM ada
// user dengan role apa pun (masalah ayam-telur: butuh role untuk verifikasi
// role, jadi harus ada jalur bootstrap terpisah).
exports.triggerChurnEvaluation = functions
  .runWith({ timeoutSeconds: 540, memory: '512MB' })
  .https.onRequest(async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).send('');
      return;
    }

    const authHeader = req.headers.authorization || '';
    const idToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!idToken) {
      res.status(401).send('Unauthorized - tidak ada token login. Fungsi ini harus dipanggil dari dalam app setelah login sebagai brand, bukan dibuka langsung di browser.');
      return;
    }

    let decodedToken;
    try {
      decodedToken = await admin.auth().verifyIdToken(idToken);
    } catch (e) {
      res.status(401).send('Token tidak valid atau kadaluarsa: ' + e.message);
      return;
    }

    if (decodedToken.role !== 'brand') {
      res.status(403).send('Forbidden - akun ini bukan role brand.');
      return;
    }

    const { year, month } = req.query;
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
