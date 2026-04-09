(function () {
  'use strict';

  // Penyimpanan sengaja memakai localStorage browser agar kompatibel dengan
  // Web-to-APK (WebView/Capacitor/Cordova/PWA): data tetap tersimpan di app.
  const STORAGE_KEY = 'payumkm_base_string';
  const STORAGE_PAYLOAD = 'payumkm_last_payload';
  const STORAGE_TRANSACTIONS = 'payumkm_transactions';
  const STORAGE_NAMA_REKAP = 'payumkm_nama_rekap';

  // ----- CRC16-CCITT untuk QRIS (wajib sesuai EMVCo) -----
  function calculateCRC16(data) {
    var crc = 0xFFFF;
    var polynomial = 0x1021;
    for (var i = 0; i < data.length; i++) {
      crc ^= (data.charCodeAt(i) << 8);
      for (var j = 0; j < 8; j++) {
        if (crc & 0x8000) {
          crc = (crc << 1) ^ polynomial;
        } else {
          crc = crc << 1;
        }
        crc &= 0xFFFF;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  function parseTLV(payload) {
    var items = [];
    var i = 0;
    while (i < payload.length) {
      if (i + 4 > payload.length) return null;
      var tag = payload.substring(i, i + 2);
      var lenRaw = payload.substring(i + 2, i + 4);
      var len = parseInt(lenRaw, 10);
      if (isNaN(len) || len < 0) return null;
      var valueStart = i + 4;
      var valueEnd = valueStart + len;
      if (valueEnd > payload.length) return null;
      items.push({
        tag: tag,
        value: payload.substring(valueStart, valueEnd)
      });
      i = valueEnd;
    }
    return items;
  }

  function buildTLV(items) {
    return items.map(function (item) {
      var value = item.value || '';
      return item.tag + value.length.toString().padStart(2, '0') + value;
    }).join('');
  }

  function normalizeQRISString(raw) {
    var s = String(raw || '')
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .trim()
      .toUpperCase();
    if (!s) return '';

    var start = s.indexOf('000201');
    if (start > 0) s = s.substring(start);

    var idx63 = s.lastIndexOf('6304');
    if (idx63 !== -1 && s.length >= idx63 + 8) {
      s = s.substring(0, idx63 + 8);
    }
    return s;
  }

  // ----- Modifikasi QRIS: insert Tag 54 (Transaction Amount) -----
  function modifyQRIS(baseString, nominal) {
    var n = parseInt(nominal, 10);
    if (!n || n <= 0) return null;
    var nominalStr = n.toString();
    var cleaned = normalizeQRISString(baseString);
    if (!cleaned) return null;

    var tlv = parseTLV(cleaned);
    if (!tlv || tlv.length === 0) return null;

    var hasCurrencyIDR = tlv.some(function (item) {
      return item.tag === '53' && item.value === '360';
    });
    if (!hasCurrencyIDR && cleaned.indexOf('5303360') !== -1) {
      hasCurrencyIDR = true;
    }
    if (!hasCurrencyIDR) return null;

    // Hapus tag amount lama dan CRC lama jika ada
    tlv = tlv.filter(function (item) {
      return item.tag !== '54' && item.tag !== '63';
    });

    // Jika nominal diisi, wajib dynamic QR (01=12)
    var poi = tlv.find(function (item) { return item.tag === '01'; });
    if (poi) {
      poi.value = '12';
    } else {
      // Sisipkan setelah Payload Format Indicator (00) jika ada
      var idx00 = tlv.findIndex(function (item) { return item.tag === '00'; });
      var poiItem = { tag: '01', value: '12' };
      if (idx00 >= 0) tlv.splice(idx00 + 1, 0, poiItem);
      else tlv.unshift(poiItem);
    }

    var tag54Item = { tag: '54', value: nominalStr };
    var idx53 = tlv.findIndex(function (item) { return item.tag === '53'; });
    if (idx53 >= 0) tlv.splice(idx53 + 1, 0, tag54Item);
    else tlv.push(tag54Item);

    var withoutCRC = buildTLV(tlv) + '6304';
    var crc = calculateCRC16(withoutCRC);
    return withoutCRC + crc;
  }

  // ----- Tab / Menu -----
  const tabs = document.querySelectorAll('.tab-content');
  const menuItems = document.querySelectorAll('.menu-item');

  function showTab(tabId) {
    tabs.forEach(function (tab) {
      tab.classList.toggle('active', tab.id === tabId);
    });
    menuItems.forEach(function (item) {
      item.classList.toggle('active', item.getAttribute('data-tab') === tabId);
    });
    if (tabId === 'tab-scan') {
      loadSavedQRDisplay();
      loadNamaRekap();
      scanArea.classList.remove('hidden');
      scanResult.classList.add('hidden');
    }
    if (tabId === 'tab-edit') {
      loadSavedStringIntoForm();
    }
    if (tabId === 'tab-rekap') {
      renderRekapTable();
    }
  }

  menuItems.forEach(function (item) {
    item.addEventListener('click', function () {
      var tabId = item.getAttribute('data-tab');
      showTab(tabId);
    });
  });

  // ----- Scan QR dari file gambar -----
  const scanArea = document.getElementById('scan-area');
  const scanResult = document.getElementById('scan-result');
  const extractedStringEl = document.getElementById('extracted-string');
  const btnSaveString = document.getElementById('btn-save-string');
  const btnDeleteString = document.getElementById('btn-delete-string');
  const inputQrImage = document.getElementById('input-qr-image');
  const savedQrDisplay = document.getElementById('saved-qr-display');

  function loadNamaRekap() {
    var el = document.getElementById('input-nama-rekap');
    if (!el) return;
    try {
      el.value = localStorage.getItem(STORAGE_NAMA_REKAP) || '';
    } catch (e) {}
  }

  (function initNamaRekap() {
    var el = document.getElementById('input-nama-rekap');
    if (!el) return;
    el.addEventListener('input', function () {
      try {
        localStorage.setItem(STORAGE_NAMA_REKAP, el.value);
      } catch (err) {}
    });
    el.addEventListener('blur', function () {
      try {
        localStorage.setItem(STORAGE_NAMA_REKAP, el.value);
      } catch (err) {}
    });
  })();

  function loadSavedQRDisplay() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      var qrContainer = document.getElementById('saved-qris-qrcode');
      if (saved) {
        savedQrDisplay.classList.remove('hidden');
        var preview = saved.length > 60 ? saved.substring(0, 60) + '...' : saved;
        savedQrDisplay.querySelector('.saved-qr-preview').textContent = preview;
        if (qrContainer && typeof QRCode !== 'undefined') {
          qrContainer.innerHTML = '';
          new QRCode(qrContainer, {
            text: saved,
            width: 160,
            height: 160,
            colorDark: '#000000',
            colorLight: '#ffffff',
            correctLevel: QRCode.CorrectLevel.M
          });
        }
      } else {
        savedQrDisplay.classList.add('hidden');
        if (qrContainer) qrContainer.innerHTML = '';
      }
    } catch (e) {
      savedQrDisplay.classList.add('hidden');
    }
  }

  inputQrImage.addEventListener('change', function () {
    var file = this.files && this.files[0];
    if (!file) return;
    scanResult.classList.add('hidden');
    var scanner = new Html5Qrcode('reader');
    scanner.scanFile(file, false)
      .then(function (decodedText) {
        extractedStringEl.textContent = decodedText;
        scanArea.classList.add('hidden');
        scanResult.classList.remove('hidden');
        window._lastScannedString = decodedText;
      })
      .catch(function (err) {
        alert('QR code tidak ditemukan di gambar. Coba gambar lain.');
        console.warn(err);
      })
      .finally(function () {
        inputQrImage.value = '';
      });
  });

  btnSaveString.addEventListener('click', function () {
    var str = window._lastScannedString || extractedStringEl.textContent;
    if (str) {
      try {
        localStorage.setItem(STORAGE_KEY, str);
        loadSavedStringIntoForm();
        loadSavedQRDisplay();
        showTab('tab-edit');
      } catch (e) {
        console.warn('Simpan gagal:', e);
      }
    }
  });

  btnDeleteString.addEventListener('click', function () {
    if (confirm('Hapus data QR yang tersimpan?')) {
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(STORAGE_PAYLOAD);
        savedQrDisplay.classList.add('hidden');
        inputBaseString.value = '';
        inputNominal.value = '';
        inputDeskripsi.value = '';
        alert('Data QR berhasil dihapus.');
      } catch (e) {
        console.warn('Hapus gagal:', e);
      }
    }
  });

  // ----- Edit form -----
  const formEdit = document.getElementById('form-edit');
  const inputBaseString = document.getElementById('input-base-string');
  const inputNominal = document.getElementById('input-nominal');
  const inputDeskripsi = document.getElementById('input-deskripsi');

  function loadSavedStringIntoForm() {
    try {
      var saved = localStorage.getItem(STORAGE_KEY);
      inputBaseString.value = saved || '';
    } catch (e) {}
  }

  function buildPayload(baseString, nominal, deskripsi) {
    var modifiedQRIS = modifyQRIS(baseString, nominal);
    if (!modifiedQRIS) {
      return null;
    }
    return {
      base: baseString,
      nominal: parseInt(nominal, 10),
      deskripsi: (deskripsi || '').trim(),
      qrString: modifiedQRIS
    };
  }

  var btnRefreshPage = document.getElementById('btn-refresh-page');
  if (btnRefreshPage) {
    btnRefreshPage.addEventListener('click', function () {
      window.location.reload();
    });
  }

  formEdit.addEventListener('submit', function (e) {
    e.preventDefault();
    var base = inputBaseString.value.trim();
    var nominal = inputNominal.value.trim();
    var deskripsi = inputDeskripsi.value.trim();
    if (!base) {
      alert('Data dari QR masih kosong. Scan QR dulu di tab QR Gambar.');
      return;
    }
    if (!nominal || parseInt(nominal, 10) <= 0) {
      alert('Masukkan nominal yang valid.');
      return;
    }
    var payload = buildPayload(base, nominal, deskripsi);
    if (!payload) {
      alert('QRIS tidak valid atau bukan mata uang IDR (tag 5303360 tidak ditemukan).');
      return;
    }
    try {
      localStorage.setItem(STORAGE_PAYLOAD, JSON.stringify(payload));
      addTransaction({
        date: new Date().toISOString(),
        nominal: payload.nominal,
        deskripsi: payload.deskripsi || '',
        status: 'pending'
      });
    } catch (err) {
      console.warn('Simpan payload gagal:', err);
    }
    openQRPopup();
  });

  // ----- Generate QR & Popup -----
  const qrcodeContainer = document.getElementById('qrcode-container');
  const qrcodeDiv = document.getElementById('qrcode');
  const qrNominalDisplay = document.getElementById('qr-nominal-display');
  const qrDeskripsiDisplay = document.getElementById('qr-deskripsi-display');
  const qrPopup = document.getElementById('qr-popup');
  const qrPopupClose = document.getElementById('qr-popup-close');

  function formatRupiah(num) {
    return 'Rp ' + Number(num).toLocaleString('id-ID');
  }

  function renderGeneratedQR() {
    var raw = null;
    try {
      raw = localStorage.getItem(STORAGE_PAYLOAD);
    } catch (e) {}
    if (!raw) return;
    var payload;
    try {
      payload = JSON.parse(raw);
    } catch (e) { return; }
    if (!payload.qrString) return;
    qrcodeDiv.innerHTML = '';
    new QRCode(qrcodeDiv, {
      text: payload.qrString,
      width: 200,
      height: 200,
      colorDark: '#000000',
      colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
    qrNominalDisplay.textContent = formatRupiah(payload.nominal);
    qrDeskripsiDisplay.textContent = payload.deskripsi || '—';
  }

  function closeQRPopup() {
    qrPopup.classList.add('hidden');
    qrPopup.setAttribute('aria-hidden', 'true');
  }

  qrPopupClose.addEventListener('click', closeQRPopup);
  qrPopup.addEventListener('click', function (e) {
    if (e.target === qrPopup) closeQRPopup();
  });

  // Status tombol: Paid, Pending, Cancel
  var statusButtons = document.querySelectorAll('.status-btn');
  function setStatusActive(activeBtn) {
    statusButtons.forEach(function (btn) {
      var isActive = btn === activeBtn;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
    var status = activeBtn.getAttribute('data-status');
    try {
      localStorage.setItem('payumkm_last_status', status);
      updateLastTransactionStatus(status);
    } catch (err) {}
  }
  statusButtons.forEach(function (btn) {
    btn.addEventListener('click', function () {
      setStatusActive(btn);
      closeQRPopup();
    });
  });

  function openQRPopup() {
    renderGeneratedQR();
    var pendingBtn = document.querySelector('.status-btn[data-status="pending"]');
    setStatusActive(pendingBtn || statusButtons[0]);
    qrPopup.classList.remove('hidden');
    qrPopup.setAttribute('aria-hidden', 'false');
  }

  // ----- Rekap Transaksi -----
  function getTransactions() {
    try {
      var raw = localStorage.getItem(STORAGE_TRANSACTIONS);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveTransactions(list) {
    try {
      localStorage.setItem(STORAGE_TRANSACTIONS, JSON.stringify(list));
    } catch (err) {
      console.warn('Simpan rekap gagal:', err);
    }
  }

  function addTransaction(trx) {
    var list = getTransactions();
    list.push(trx);
    saveTransactions(list);
  }

  function updateLastTransactionStatus(status) {
    var list = getTransactions();
    if (list.length === 0) return;
    list[list.length - 1].status = status;
    saveTransactions(list);
  }

  function formatDate(isoStr) {
    if (!isoStr) return '—';
    var d = new Date(isoStr);
    var day = ('0' + d.getDate()).slice(-2);
    var month = ('0' + (d.getMonth() + 1)).slice(-2);
    var year = d.getFullYear();
    var h = ('0' + d.getHours()).slice(-2);
    var m = ('0' + d.getMinutes()).slice(-2);
    return day + '/' + month + '/' + year + ' ' + h + ':' + m;
  }

  function statusLabel(s) {
    return s === 'paid' ? 'Paid' : s === 'cancel' ? 'Cancel' : 'Pending';
  }

  function statusClass(s) {
    return 'status-badge status-' + (s || 'pending');
  }

  function filterTransactionsByDateRange(list, startDate, endDate) {
    if (!startDate && !endDate) return list;
    var start = startDate ? new Date(startDate) : null;
    var end = endDate ? new Date(endDate) : null;
    if (end) end.setHours(23, 59, 59, 999);
    return list.filter(function (trx) {
      var d = new Date(trx.date);
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  }

  function calculateTotalPendapatan(list) {
    return list.reduce(function (sum, trx) {
      return trx.status === 'paid' ? sum + (trx.nominal || 0) : sum;
    }, 0);
  }

  function renderRekapTable() {
    var wrap = document.getElementById('rekap-wrap');
    var tbody = document.getElementById('rekap-tbody');
    var emptyEl = document.getElementById('rekap-empty');
    var totalEl = document.getElementById('total-pendapatan');
    if (!wrap || !tbody || !emptyEl) return;
    
    var startInput = document.getElementById('filter-start');
    var endInput = document.getElementById('filter-end');
    var startDate = startInput ? startInput.value : '';
    var endDate = endInput ? endInput.value : '';
    
    var list = getTransactions();
    var filtered = filterTransactionsByDateRange(list, startDate, endDate);
    
    if (filtered.length === 0) {
      tbody.innerHTML = '';
      wrap.classList.add('rekap-empty-state');
      emptyEl.classList.remove('hidden');
      if (totalEl) totalEl.textContent = formatRupiah(0);
      return;
    }
    
    wrap.classList.remove('rekap-empty-state');
    emptyEl.classList.add('hidden');
    
    var total = calculateTotalPendapatan(filtered);
    if (totalEl) totalEl.textContent = formatRupiah(total);
    
    var sorted = filtered.slice().sort(function (a, b) {
      return new Date(b.date) - new Date(a.date);
    });
    tbody.innerHTML = sorted.map(function (trx) {
      var status = trx.status || 'pending';
      return '<tr>' +
        '<td class="col-date">' + formatDate(trx.date) + '</td>' +
        '<td class="col-nominal">' + formatRupiah(trx.nominal) + '</td>' +
        '<td class="col-status"><span class="' + statusClass(status) + '">' + statusLabel(status) + '</span></td>' +
        '</tr>';
    }).join('');
  }

  function exportRekapPDF() {
    var startInput = document.getElementById('filter-start');
    var endInput = document.getElementById('filter-end');
    var startDate = startInput ? startInput.value : '';
    var endDate = endInput ? endInput.value : '';
    
    // Validasi max 30 hari
    if (startDate && endDate) {
      var start = new Date(startDate);
      var end = new Date(endDate);
      var diff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
      if (diff > 30) {
        alert('Maksimal rentang tanggal export adalah 30 hari.');
        return;
      }
      if (diff < 0) {
        alert('Tanggal akhir harus lebih besar dari tanggal awal.');
        return;
      }
    }
    
    var list = getTransactions();
    var filtered = filterTransactionsByDateRange(list, startDate, endDate);
    
    if (filtered.length === 0) {
      alert('Tidak ada transaksi untuk di-export.');
      return;
    }
    
    var sorted = filtered.slice().sort(function (a, b) {
      return new Date(b.date) - new Date(a.date);
    });
    
    var total = calculateTotalPendapatan(sorted);
    
    var { jsPDF } = window.jspdf;
    var doc = new jsPDF();
    
    // Header
    doc.setFontSize(18);
    doc.setFont(undefined, 'bold');
    doc.text('NotaQ', 14, 20);
    doc.setFontSize(12);
    doc.setFont(undefined, 'normal');
    doc.text('Rekap Transaksi', 14, 28);
    
    if (startDate || endDate) {
      var rangeText = 'Periode: ' + (startDate || '...') + ' s/d ' + (endDate || '...');
      doc.setFontSize(10);
      doc.text(rangeText, 14, 35);
    }
    
    // Table
    var tableData = sorted.map(function (trx) {
      return [
        formatDate(trx.date),
        formatRupiah(trx.nominal),
        trx.deskripsi || '—',
        statusLabel(trx.status || 'pending')
      ];
    });
    
    doc.autoTable({
      startY: startDate || endDate ? 40 : 35,
      head: [['Tanggal', 'Nominal', 'Deskripsi', 'Status']],
      body: tableData,
      theme: 'grid',
      styles: { fontSize: 9 },
      headStyles: { fillColor: [40, 167, 69], textColor: 255 }
    });
    
    // Total
    var finalY = doc.lastAutoTable.finalY || 40;
    doc.setFontSize(12);
    doc.setFont(undefined, 'bold');
    doc.text('Total Pendapatan (Paid): ' + formatRupiah(total), 14, finalY + 10);
    
    // Footer: Dibuat oleh [nama]
    doc.setFontSize(8);
    doc.setFont(undefined, 'normal');
    var namaRekap = '';
    try {
      namaRekap = localStorage.getItem(STORAGE_NAMA_REKAP) || '';
    } catch (e) {}
    doc.text('Dibuat oleh: ' + (namaRekap.trim() || '—'), 14, doc.internal.pageSize.height - 10);
    
    var filename = 'Rekap_NotaQ_' + (startDate || 'All') + '_' + (endDate || 'All') + '.pdf';
    doc.save(filename);
  }

  // Upgrade popup
  var upgradePopup = document.getElementById('upgrade-popup');
  var btnUpgradePro = document.getElementById('btn-upgrade-pro');
  var upgradePopupClose = document.getElementById('upgrade-popup-close');
  
  if (btnUpgradePro) {
    btnUpgradePro.addEventListener('click', function () {
      upgradePopup.classList.remove('hidden');
      upgradePopup.setAttribute('aria-hidden', 'false');
    });
  }
  
  if (upgradePopupClose) {
    upgradePopupClose.addEventListener('click', function () {
      upgradePopup.classList.add('hidden');
      upgradePopup.setAttribute('aria-hidden', 'true');
    });
  }
  
  if (upgradePopup) {
    upgradePopup.addEventListener('click', function (e) {
      if (e.target === upgradePopup) {
        upgradePopup.classList.add('hidden');
        upgradePopup.setAttribute('aria-hidden', 'true');
      }
    });
  }

  // Filter & Export handlers
  var btnFilterRekap = document.getElementById('btn-filter-rekap');
  var btnExportPDF = document.getElementById('btn-export-pdf');
  
  if (btnFilterRekap) {
    btnFilterRekap.addEventListener('click', function () {
      var startInput = document.getElementById('filter-start');
      var endInput = document.getElementById('filter-end');
      var startDate = startInput ? startInput.value : '';
      var endDate = endInput ? endInput.value : '';
      
      // Validasi max 30 hari
      if (startDate && endDate) {
        var start = new Date(startDate);
        var end = new Date(endDate);
        var diff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
        if (diff > 30) {
          alert('Maksimal rentang tanggal filter adalah 30 hari.');
          return;
        }
        if (diff < 0) {
          alert('Tanggal akhir harus lebih besar dari tanggal awal.');
          return;
        }
      }
      renderRekapTable();
    });
  }
  
  if (btnExportPDF) {
    btnExportPDF.addEventListener('click', exportRekapPDF);
  }

  // Init: load form dari storage (persist on refresh), show first tab
  loadSavedStringIntoForm();
  loadSavedQRDisplay();
  loadNamaRekap();
  showTab('tab-edit');
})();
