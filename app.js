(function () {
  'use strict';

  // --- KONFIGURASI DEFAULT ---
  var DEFAULT_QRIS_STRING = "00020101021126670016COM.NOBUBANK.WWW01189360050300000879140214508257991305870303UMI51440014ID.CO.QRIS.WWW0215ID20232921284770303UMI5204541153033605802ID5920JOJO STORE OK13496366006CIAMIS61054621162070703A0163045679";
  
  const STORAGE_KEY_QRIS = 'payumkm_base_string';
  const STORAGE_TRANSACTIONS = 'payumkm_transactions';

  // --- INISIALISASI ---
  function initApp() {
    if (!localStorage.getItem(STORAGE_KEY_QRIS)) {
      localStorage.setItem(STORAGE_KEY_QRIS, DEFAULT_QRIS_STRING);
    }
    renderHistory();
  }

  // --- LOGIKA QRIS ---
  function calculateCRC16(data) {
    var crc = 0xFFFF;
    var polynomial = 0x1021;
    for (var i = 0; i < data.length; i++) {
      crc ^= (data.charCodeAt(i) << 8);
      for (var j = 0; j < 8; j++) {
        if (crc & 0x8000) crc = (crc << 1) ^ polynomial;
        else crc = crc << 1;
        crc &= 0xFFFF;
      }
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
  }

  function parseTLV(payload) {
    var items = [], i = 0;
    while (i < payload.length) {
      if (i + 4 > payload.length) return null;
      var tag = payload.substring(i, i + 2);
      var lenRaw = payload.substring(i + 2, i + 4);
      var len = parseInt(lenRaw, 10);
      if (isNaN(len) || len < 0) return null;
      var valueStart = i + 4;
      var valueEnd = valueStart + len;
      if (valueEnd > payload.length) return null;
      items.push({ tag: tag, value: payload.substring(valueStart, valueEnd) });
      i = valueEnd;
    }
    return items;
  }

  function buildTLV(items) {
    return items.map(function (item) {
      return item.tag + item.value.length.toString().padStart(2, '0') + item.value;
    }).join('');
  }

  function generateDynamicQRIS(baseString, nominal) {
    var n = parseInt(nominal, 10);
    if (!n || n <= 0) return null;
    var nominalStr = n.toString();
    var cleaned = baseString.trim().toUpperCase();
    if (!cleaned.startsWith('000201')) return null;

    var tlv = parseTLV(cleaned);
    if (!tlv || tlv.length === 0) return null;
    if (!tlv.some(function (item) { return item.tag === '53' && item.value === '360'; })) return null;

    tlv = tlv.filter(function (item) { return item.tag !== '54' && item.tag !== '63'; });
    
    var poi = tlv.find(function (item) { return item.tag === '01'; });
    if (poi) poi.value = '12';
    else tlv.unshift({ tag: '01', value: '12' });

    var tag54Item = { tag: '54', value: nominalStr };
    var idx53 = tlv.findIndex(function (item) { return item.tag === '53'; });
    if (idx53 >= 0) tlv.splice(idx53 + 1, 0, tag54Item);
    else tlv.push(tag54Item);

    var withoutCRC = buildTLV(tlv) + '6304';
    return withoutCRC + calculateCRC16(withoutCRC);
  }

  // --- DOM ELEMENTS ---
  const form = document.getElementById('payment-form');
  const inputNominal = document.getElementById('input-nominal');
  const popup = document.getElementById('qr-popup');
  const qrcodeContainer = document.getElementById('qrcode');
  const displayAmount = document.getElementById('display-amount');
  // btnDownloadQR dihapus reference-nya
  const navItems = document.querySelectorAll('.nav-item');
  const tabContents = document.querySelectorAll('.tab-content');
  
  let currentTransaction = null;

  // --- NAVIGASI TAB ---
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      navItems.forEach(nav => nav.classList.remove('active'));
      item.classList.add('active');
      
      const targetId = item.getAttribute('data-tab');
      tabContents.forEach(content => {
        content.classList.remove('active');
        if(content.id === targetId) content.classList.add('active');
      });

      if(targetId === 'tab-riwayat') renderHistory();
    });
  });

  // --- EVENT HANDLERS ---
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var nominal = inputNominal.value;
    if (!nominal || parseInt(nominal) <= 0) return alert("Nominal tidak valid");

    var baseString = localStorage.getItem(STORAGE_KEY_QRIS);
    var dynamicString = generateDynamicQRIS(baseString, nominal);

    if (dynamicString) {
      showQRPopup(dynamicString, nominal);
    } else {
      alert("Gagal generate QR. Cek string QRIS.");
    }
  });

  function showQRPopup(qrString, nominal) {
    qrcodeContainer.innerHTML = '';
    
    // Generate QR
    new QRCode(qrcodeContainer, {
      text: qrString, 
      width: 200, 
      height: 200,
      colorDark: "#000000", 
      colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });

    displayAmount.textContent = formatRupiah(nominal);
    currentTransaction = {
      date: new Date().toISOString(),
      nominal: parseInt(nominal),
      status: 'pending'
    };

    popup.classList.add('active');
  }

  // Fungsi download DIHAPUS

  document.getElementById('btn-close-popup').addEventListener('click', closePopup);
  popup.addEventListener('click', (e) => { if (e.target === popup) closePopup(); });

  function closePopup() {
    popup.classList.remove('active');
    setTimeout(() => { qrcodeContainer.innerHTML = ''; }, 300);
  }

  document.getElementById('btn-status-paid').addEventListener('click', function () {
    if (currentTransaction) {
      currentTransaction.status = 'paid';
      saveTransaction(currentTransaction); // HANYA SIMPAN JIKA PAID
      alert("Transaksi Berhasil Disimpan!");
      closePopup();
      form.reset();
    }
  });

  document.getElementById('btn-status-cancel').addEventListener('click', function () {
    if (currentTransaction) {
      // JANGAN SIMPAN KE RIWAYAT
      // currentTransaction.status = 'cancel';
      // saveTransaction(currentTransaction); -> Dihapus
      
      alert("Transaksi Dibatalkan.");
      closePopup();
      form.reset();
    }
  });

  // --- MANAJEMEN RIWAYAT ---
  function getTransactions() {
    try {
      var raw = localStorage.getItem(STORAGE_TRANSACTIONS);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function saveTransaction(trx) {
    var list = getTransactions();
    list.push(trx);
    localStorage.setItem(STORAGE_TRANSACTIONS, JSON.stringify(list));
    renderHistory();
  }

  function renderHistory() {
    var tbody = document.getElementById('history-tbody');
    var emptyDiv = document.getElementById('history-empty');
    var startVal = document.getElementById('filter-start').value;
    var endVal = document.getElementById('filter-end').value;

    var list = getTransactions();
    
    if (startVal || endVal) {
      var start = startVal ? new Date(startVal) : null;
      var end = endVal ? new Date(endVal) : null;
      if (end) end.setHours(23, 59, 59, 999);
      
      list = list.filter(function (trx) {
        var d = new Date(trx.date);
        if (start && d < start) return false;
        if (end && d > end) return false;
        return true;
      });
    }

    list.sort(function (a, b) { return new Date(b.date) - new Date(a.date); });

    tbody.innerHTML = '';
    if (list.length === 0) {
      emptyDiv.style.display = 'block';
    } else {
      emptyDiv.style.display = 'none';
      list.forEach(function (trx) {
        var tr = document.createElement('tr');
        var dateObj = new Date(trx.date);
        var dateStr = dateObj.toLocaleDateString('id-ID') + ' ' + dateObj.toLocaleTimeString('id-ID', {hour: '2-digit', minute:'2-digit'});
        
        tr.innerHTML = `
          <td style="font-size:0.8rem; color:#6B7280;">${dateStr}</td>
          <td style="font-weight:700; color:#111827;">${formatRupiah(trx.nominal)}</td>
          <td><span class="status-badge status-${trx.status}">${trx.status.toUpperCase()}</span></td>
        `;
        tbody.appendChild(tr);
      });
    }
  }

  document.getElementById('btn-filter').addEventListener('click', renderHistory);

  // --- UTILITIES ---
  function formatRupiah(num) {
    return 'Rp ' + Number(num).toLocaleString('id-ID');
  }

  initApp();
})();