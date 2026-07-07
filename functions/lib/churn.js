/**
 * lib/churn.js — Label Churn Bulanan & Churn Biasa
 * ==================================================
 *
 * ATURAN CHURN BULANAN (diverifikasi silang ke kasus Sony & Bayu):
 *   Customer berstatus "Churn Bulanan" di bulan M jika dia pernah aktif
 *   sebelumnya, TIDAK beli di bulan M-1 (kosong ke-1) DAN TIDAK beli di
 *   bulan M (kosong ke-2). Status jatuh di bulan kosong KEDUA.
 *
 *   Verifikasi: Sony aktif April, kosong Mei (ke-1), kosong Juni (ke-2)
 *   -> churn di Juni. Bayu aktif Juli, kosong Agustus (ke-1), kosong
 *   September (ke-2) -> wajib followup di September. Keduanya cocok.
 *
 *   Un-churn: begitu ada pembelian lagi di bulan mana pun, status churn
 *   hilang mulai bulan itu. Siklus bisa berulang.
 *
 * ATURAN CHURN BIASA:
 *   Customer yang lifetime total pembelian >= 2 kali, lalu tidak beli
 *   lagi (tanpa batas bulan spesifik - dievaluasi longgar, bukan per 2
 *   bulan konsisten). Dipakai sebagai label terpisah, tidak menggantikan
 *   Churn Bulanan.
 *
 * INPUT yang dibutuhkan: riwayat count order per bulan per customer,
 * bukan cuma daftar identitas. Kalau histori cuma identitas tanpa
 * rincian order per bulan, fungsi ini tidak bisa jalan untuk bulan-bulan
 * sebelum sistem live.
 */

/**
 * @param {Array<{year:number, month:number, order_count:number}>} monthlyHistory
 *        Harus urut kronologis, idealnya tanpa bulan yang hilang di tengah
 *        (bulan tanpa order tetap harus muncul dengan order_count:0).
 * @param {{year:number, month:number}} evalMonth - bulan yang mau dievaluasi
 * @returns {{isChurnBulanan:boolean, isChurnBiasa:boolean, lifetimeOrders:number}}
 */
function evaluateChurnStatus(monthlyHistory, evalMonth) {
  const sorted = [...monthlyHistory].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month
  );

  const idx = sorted.findIndex(
    (m) => m.year === evalMonth.year && m.month === evalMonth.month
  );
  if (idx === -1) {
    throw new Error('evalMonth tidak ada di monthlyHistory - pastikan bulan kosong tetap disertakan dengan order_count:0');
  }

  const upToEval = sorted.slice(0, idx + 1);
  const lifetimeOrders = upToEval.reduce((sum, m) => sum + m.order_count, 0);

  // Churn Bulanan: cek 2 bulan kosong berturut berakhir di evalMonth,
  // dan pernah ada aktivitas sebelum kedua bulan kosong itu.
  const currentMonthCount = sorted[idx].order_count;
  const prevMonthCount = idx >= 1 ? sorted[idx - 1].order_count : null;
  const everActiveBeforeGap =
    idx >= 2 && sorted.slice(0, idx - 1).some((m) => m.order_count > 0);

  const isChurnBulanan =
    currentMonthCount === 0 &&
    prevMonthCount === 0 &&
    everActiveBeforeGap;

  // Churn Biasa: lifetime >=2 order, dan bulan ini kosong (tidak beli lagi)
  const isChurnBiasa = lifetimeOrders >= 2 && currentMonthCount === 0;

  return { isChurnBulanan, isChurnBiasa, lifetimeOrders };
}

module.exports = { evaluateChurnStatus };

/**
 * Bangun array bulan berurutan (tanpa bolong) dari bulan pertama customer
 * pernah order sampai evalMonth, mengisi 0 untuk bulan yang kosong.
 * WAJIB tidak ada bolong - evaluateChurnStatus mengasumsikan array-nya
 * kontinu, kalau ada bulan yang hilang dari array, "bulan kosong berturut"
 * jadi salah hitung.
 *
 * @param {string} firstMonthKey - format "YYYY-MM", bulan pertama ada order
 * @param {{year:number, month:number}} evalMonth
 * @param {Object<string, number>} countsByMonth - key "YYYY-MM" -> jumlah order
 * @returns {Array<{year:number, month:number, order_count:number}>}
 */
function buildContinuousMonthlyHistory(firstMonthKey, evalMonth, countsByMonth) {
  const [firstYear, firstMonthNum] = firstMonthKey.split('-').map(Number);
  const history = [];

  let y = firstYear;
  let m = firstMonthNum;

  while (y < evalMonth.year || (y === evalMonth.year && m <= evalMonth.month)) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    history.push({ year: y, month: m, order_count: countsByMonth[key] || 0 });
    m++;
    if (m > 12) { m = 1; y++; }
  }

  return history;
}

module.exports.buildContinuousMonthlyHistory = buildContinuousMonthlyHistory;
