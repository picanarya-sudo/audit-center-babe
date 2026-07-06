/**
 * MARGIN CALCULATION — order_items x SKU cost matching
 * ======================================================
 *
 * MASALAH STRUKTURAL YANG HARUS DISELESAIKAN DULU:
 *
 * `order_items` bukan daftar item rapi. Contoh nyata dari data kamu:
 *
 *   "1x 2 Bintang Beer Radler 330ml [Promo Juli]\n  - 2x Bintang Radler 330ml"
 *
 * Baris pertama itu LABEL BUNDLE PROMO, bukan SKU nyata — dia tidak boleh
 * dihitung cost-nya sendiri. Baris kedua (diawali "  - ") adalah SKU asli
 * yang benar-benar dikirim ke customer. Kalau saya hitung cost dari KEDUA
 * baris itu, cost-nya dobel dan margin jadi salah — kelihatan masuk akal,
 * padahal keliru.
 *
 * Aturan parsing:
 *   - Baris yang diawali "  - " (indented dash) = SKU asli, ikut dihitung cost.
 *   - Baris top-level (tanpa "- ") yang DIIKUTI baris indented di bawahnya
 *     = header bundle/promo, dilewati (bukan SKU nyata, cuma label tampilan).
 *   - Baris top-level yang TIDAK diikuti baris indented = SKU berdiri sendiri
 *     (contoh: "3x Bintang Pilsener [Besar] 620ml"), ikut dihitung cost.
 *
 * MATCHING KE SKU COST LIST:
 *   - EXACT match dulu (case-insensitive, whitespace dirapikan). TIDAK pakai
 *     fuzzy matching (mis. Levenshtein) untuk nama produk — fuzzy match bisa
 *     menyamakan "Bintang Radler 330ml" dengan "Bintang Radler Zero 330ml"
 *     yang costnya beda, dan itu kesalahan yang tidak kelihatan di angka akhir.
 *   - Item yang tidak ketemu di SKU list masuk ke `unmatchedItems` — DITANDAI
 *     untuk direview manual, bukan ditaksir. Kalau unmatched rate tinggi,
 *     itu sinyal SKU list belum lengkap/naming belum konsisten dengan
 *     order_items, bukan sesuatu yang bisa "dibulatkan" oleh kode.
 *
 * KEPUTUSAN DESAIN — MARGIN DIBEKUKAN SAAT INGESTION, BUKAN DIHITUNG ULANG:
 *   Kalau SKU cost di-update bulan depan (harga modal naik), margin order
 *   BULAN LALU tidak boleh ikut berubah kalau nanti dihitung ulang — itu
 *   akan merusak angka historis (loyal customer, CLV, tren bulanan). Maka
 *   margin dihitung SEKALI saat order masuk (pakai cost yang berlaku saat
 *   itu) dan disimpan sebagai field `margin` di dokumen order. Update SKU
 *   cost cuma memengaruhi order yang masuk SETELAH update, tidak retroaktif.
 */

/**
 * Parse teks order_items jadi daftar SKU nyata yang layak dihitung cost-nya.
 * @param {string} orderItemsText - isi kolom order_items apa adanya
 * @returns {Array<{qty:number, name:string, rawLine:string}>}
 */
function parseOrderItemLines(orderItemsText) {
  if (!orderItemsText) return [];

  const lines = orderItemsText.split('\n');
  const result = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isIndented = /^\s+-\s*/.test(line);

    if (isIndented) {
      // baris SKU asli di dalam bundle
      const parsed = parseQtyName(line.replace(/^\s+-\s*/, ''));
      if (parsed) result.push({ ...parsed, rawLine: line });
      continue;
    }

    // baris top-level: cek apakah baris berikutnya adalah anak (indented)
    const nextLine = lines[i + 1] || '';
    const nextIsChild = /^\s+-\s*/.test(nextLine);

    if (nextIsChild) {
      // ini header bundle/promo — dilewati, cost-nya sudah ada di baris anak
      continue;
    }

    // top-level tanpa anak = SKU berdiri sendiri
    const parsed = parseQtyName(line);
    if (parsed) result.push({ ...parsed, rawLine: line });
  }

  return result;
}

/**
 * Parse "2x Bintang Radler 330ml" -> {qty: 2, name: "Bintang Radler 330ml"}
 * Kalau tidak ada prefix qty (jarang terjadi), default qty = 1.
 */
function parseQtyName(line) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const match = trimmed.match(/^(\d+)\s*x\s*(.+)$/i);
  if (match) {
    return { qty: parseInt(match[1], 10), name: match[2].trim() };
  }
  // fallback: tidak ada pola "NxNama", anggap qty 1, nama = baris utuh
  return { qty: 1, name: trimmed };
}

/** Normalisasi nama untuk exact-match yang tidak sensitif ke whitespace/case. */
function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Hitung margin satu order.
 * @param {string} orderItemsText - kolom order_items dari order_master
 * @param {number} totalNominal - kolom total_nominal (revenue order, net diskon)
 * @param {Map<string, number>} skuCostMap - normalizeName(item_name) -> unit_cost
 * @returns {{margin:number, totalCost:number, matchedItems:Array, unmatchedItems:Array}}
 */
function calculateOrderMargin(orderItemsText, totalNominal, skuCostMap) {
  const lineItems = parseOrderItemLines(orderItemsText);

  let totalCost = 0;
  const matchedItems = [];
  const unmatchedItems = [];

  for (const item of lineItems) {
    const key = normalizeName(item.name);
    if (skuCostMap.has(key)) {
      const unitCost = skuCostMap.get(key);
      const lineCost = unitCost * item.qty;
      totalCost += lineCost;
      matchedItems.push({ ...item, unitCost, lineCost });
    } else {
      unmatchedItems.push(item);
    }
  }

  return {
    margin: totalNominal - totalCost,
    totalCost,
    matchedItems,
    unmatchedItems,
    // true kalau ada item yang gagal matched -> margin ini TIDAK LENGKAP,
    // jangan dipakai sebagai angka final tanpa review
    isPartial: unmatchedItems.length > 0,
  };
}

/**
 * Bangun skuCostMap dari CSV bulk-upload SKU cost.
 * Format CSV yang diharapkan: item_name, unit_cost
 * (kalau ada sku_code, bisa ditambah sebagai kolom opsional untuk referensi,
 * tapi matching tetap berbasis item_name karena itu yang muncul di order_items)
 * @param {Array<{item_name:string, unit_cost:string}>} skuRows - hasil parse CSV
 * @returns {Map<string, number>}
 */
function buildSkuCostMap(skuRows) {
  const map = new Map();
  for (const row of skuRows) {
    const key = normalizeName(row.item_name);
    const cost = parseFloat(row.unit_cost);
    if (!isNaN(cost)) {
      map.set(key, cost);
    }
  }
  return map;
}

module.exports = {
  parseOrderItemLines,
  calculateOrderMargin,
  buildSkuCostMap,
  normalizeName,
};
