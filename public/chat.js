// =====================================================================
// chat.js — menghubungkan halaman chat dengan backend (/api/chat)
//
// Alur besarnya:
//   Pengguna mengetik / bicara / memilih file
//     -> tampilkan pesan pengguna di layar
//     -> kirim ke backend lewat fetch()
//     -> tampilkan animasi "mengetik" + pesan status jika lama
//     -> terima jawaban SEPOTONG-SEPOTONG (streaming) dan tampilkan langsung
//        (bisa dihentikan dengan tombol Stop)
//     -> simpan percakapan supaya nyambung dan tidak hilang saat refresh
// =====================================================================


// ---------------------------------------------------------------------
// LANGKAH 1: Ambil elemen-elemen HTML yang akan kita pakai
// ---------------------------------------------------------------------
// document.getElementById('x') mencari elemen yang punya id="x" di index.html.
// Kita simpan di variabel supaya tidak perlu mencari berulang-ulang.
const stageEl = document.getElementById('stage');          // tampilan chat (maskot + percakapan)
const guideEl = document.getElementById('guide');          // halaman Panduan Kualitas Air
const heroForm = document.getElementById('heroForm');      // form kirim pesan
const heroInput = document.getElementById('heroInput');
const sendButton = document.getElementById('sendButton');
const stopButton = document.getElementById('stopButton');  // tombol Stop (muncul saat menunggu)
const micButton = document.getElementById('micButton');    // tombol input suara
const attachButton = document.getElementById('attachButton'); // tombol unggah foto/dokumen
const messagesEl = document.getElementById('messages');    // wadah gelembung pesan
const fileInput = document.getElementById('fileInput');    // <input type="file"> tersembunyi
const attachmentEl = document.getElementById('attachment');
const attachmentThumb = document.getElementById('attachmentThumb');
const attachmentIcon = document.getElementById('attachmentIcon');
const attachmentName = document.getElementById('attachmentName');
const removeAttachmentBtn = document.getElementById('removeAttachment');
const newChatBtn = document.getElementById('newChat');     // menu "Chat Baru"
const openGuideBtn = document.getElementById('openGuide'); // menu "Panduan Kualitas Air"
const guideToChatBtn = document.getElementById('guideToChat'); // tombol "Tanya Tirta" di halaman panduan
const modelButton = document.getElementById('modelButton'); // tombol pilihan model di atas
const modelLabel = document.getElementById('modelLabel');
const modelMenu = document.getElementById('modelMenu');
const summaryBar = document.getElementById('summaryBar');       // wadah tombol ringkasan
const summaryButton = document.getElementById('summaryButton'); // tombol "Buat ringkasan laporan"
const outageEl = document.getElementById('outage');             // halaman Info Gangguan
const openOutageBtn = document.getElementById('openOutage');    // menu "Info Gangguan"
const outageForm = document.getElementById('outageForm');
const outageInput = document.getElementById('outageInput');
const outageList = document.getElementById('outageList');
const outageCount = document.getElementById('outageCount');

// querySelectorAll mengambil BANYAK elemen sekaligus (hasilnya seperti array)
const chipButtons = document.querySelectorAll('.chip');     // tombol kategori keluhan
const menuItems = document.querySelectorAll('.menu-item[data-view]');


// ---------------------------------------------------------------------
// LANGKAH 2: Siapkan "state" (data yang diingat selama halaman terbuka)
// ---------------------------------------------------------------------
// conversation = seluruh percakapan. Server TIDAK menyimpan percakapan
// (sesuai aturan privasi), jadi browser yang mengingat, lalu mengirimkan
// riwayatnya lagi setiap kali bertanya.
// Setiap item: { role: 'user' | 'model', text, model?, attachment?: { name, type } }
//          atau { role: 'summary', data, model, createdAt, attachments } untuk kartu ringkasan
let conversation = [];

// File yang sedang dipilih tapi belum dikirim (null = tidak ada)
let selectedFile = null;

// Penanda sedang menunggu jawaban, supaya pengguna tidak mengirim dobel
let isSending = false;

// AbortController dipakai untuk MEMBATALKAN fetch yang sedang berjalan (tombol Stop)
let currentController = null;

// Nomor sesi chat, bertambah setiap "Chat Baru". Dipakai agar jawaban dari
// percakapan lama yang baru selesai tidak ikut masuk ke percakapan baru.
let chatSession = 0;

// false = tampilan awal (maskot, judul, kategori)
// true  = mode chat: maskot disembunyikan, percakapan memenuhi area tengah
let isChatMode = false;

// Model Gemini yang dipilih di dropdown (null = pakai default dari server)
let selectedModel = null;

// Aturan yang sama dengan backend. Kita cek di browser dulu supaya pengguna
// langsung dapat pesan yang jelas tanpa harus menunggu upload selesai.
// (Backend tetap mengecek ulang — validasi di browser bisa diakali.)
const MAX_HISTORY = 20;
const MAX_FILE_MB = 5;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain'];


// ---------------------------------------------------------------------
// LANGKAH 3: Fungsi untuk menampilkan pesan di layar
// ---------------------------------------------------------------------

// 3a. Mengamankan teks sebelum dimasukkan ke HTML.
// Jika teks berisi "<script>", tanpa langkah ini browser bisa menjalankannya
// (serangan XSS). Kita ubah karakter berbahaya menjadi kode aman.
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// 3b. Gemini sering menjawab dengan format Markdown sederhana, misalnya
// **tebal** dan daftar "- poin". Fungsi ini mengubahnya menjadi HTML.
// Penting: escapeHtml dijalankan DULU, baru format ditambahkan.
function formatBotText(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') // **tebal** -> <strong>
    .replace(/^\s*[-*]\s+/gm, '• ');                  // "- poin" / "* poin" -> "• poin"
}

// 3c. Membuat satu gelembung pesan dan menaruhnya di layar.
//   role : 'user' | 'bot' | 'error' | 'note'
//   text : isi pesan
//   options.file       : File yang baru dilampirkan (bisa ditampilkan pratinjaunya)
//   options.attachment : { name, type } lampiran dari percakapan tersimpan (tanpa isi file)
// Mengembalikan { bubble, body } supaya isi gelembung bot bisa diperbarui
// sedikit demi sedikit saat jawaban streaming masuk.
function addMessage(role, text, options = {}) {
  // Buat elemen <div class="msg user"> / <div class="msg bot"> / dst.
  const bubble = document.createElement('div');
  bubble.className = role === 'user' ? 'msg user' : role === 'bot' ? 'msg bot' : `msg bot ${role}`;

  // Jika ada lampiran, tampilkan dulu di atas teks
  if (options.file && options.file.type.startsWith('image/')) {
    // Foto baru: tampilkan gambar kecil. createObjectURL membuat alamat
    // sementara agar file lokal bisa ditampilkan tanpa diupload.
    const img = document.createElement('img');
    img.src = URL.createObjectURL(options.file);
    img.alt = 'Foto yang dilampirkan';
    img.className = 'msg-image';
    bubble.appendChild(img);
  } else if (options.file || options.attachment) {
    // Dokumen, atau lampiran dari percakapan tersimpan (isi file tidak disimpan)
    const info = options.file || options.attachment;
    const badge = document.createElement('span');
    badge.className = 'msg-file';
    badge.textContent = `${info.type.startsWith('image/') ? '🖼️' : '📄'} ${info.name}`;
    bubble.appendChild(badge);
  }

  // Isi teks. Pesan bot diformat; pesan lain cukup textContent
  // (textContent otomatis aman, tidak bisa menyisipkan HTML).
  const body = document.createElement('div');
  if (role === 'bot') {
    body.innerHTML = formatBotText(text);
  } else {
    body.textContent = text;
  }
  if (text || role === 'bot') bubble.appendChild(body);

  messagesEl.appendChild(bubble);
  scrollToBottom();
  return { bubble, body };
}

// 3d. Bagian bawah jawaban bot: nama model + tombol Salin.
// getText adalah fungsi yang mengembalikan teks jawaban saat tombol diklik.
function addBotFooter(bubble, model, getText) {
  const footer = document.createElement('div');
  footer.className = 'msg-footer';

  if (model) {
    const label = document.createElement('span');
    label.className = 'source-label';
    label.textContent = model;
    label.title = 'Model AI yang menjawab';
    footer.appendChild(label);
  }

  // Tombol Salin: memakai Clipboard API bawaan browser
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'copy-btn';
  copyBtn.textContent = 'Salin';
  copyBtn.setAttribute('aria-label', 'Salin jawaban');
  copyBtn.addEventListener('click', async () => {
    try {
      // Buang tanda Markdown supaya hasil tempelan rapi (**tebal** -> tebal, "- " -> "• ")
      const plain = getText()
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/^\s*[-*]\s+/gm, '• ');
      await navigator.clipboard.writeText(plain);
      copyBtn.textContent = 'Tersalin ✓';
    } catch {
      copyBtn.textContent = 'Gagal menyalin';
    }
    // Kembalikan tulisan tombol setelah 2 detik
    setTimeout(() => (copyBtn.textContent = 'Salin'), 2000);
  });
  footer.appendChild(copyBtn);

  bubble.appendChild(footer);
}

// 3e. Animasi titik-titik "Tirta sedang mengetik", ditambah pesan status
// jika jawaban belum datang setelah beberapa detik.
function showTyping() {
  const typing = document.createElement('div');
  typing.className = 'msg bot typing';
  typing.setAttribute('aria-label', 'Tirta sedang mengetik');
  typing.innerHTML = '<span class="dots"><i></i><i></i><i></i></span><span class="typing-status"></span>';
  messagesEl.appendChild(typing);
  scrollToBottom();

  // setTimeout menjalankan fungsi setelah jeda tertentu (dalam milidetik).
  // Id timer disimpan supaya bisa dibatalkan saat jawaban datang.
  const status = typing.querySelector('.typing-status');
  typing.timers = [
    setTimeout(() => (status.textContent = 'Sedang mengantre ke server AI…'), 5000),
    setTimeout(() => (status.textContent = 'Server AI sedang ramai, mohon tunggu sebentar…'), 15000),
    setTimeout(() => (status.textContent = 'Masih menunggu. Anda bisa menekan Stop lalu mencoba model lain.'), 30000),
  ];
  return typing; // dikembalikan supaya nanti bisa dihapus
}

function removeTyping(typing) {
  if (!typing) return;
  typing.timers.forEach(clearTimeout); // batalkan pesan status yang belum muncul
  typing.remove();
}

// 3f. Gulir otomatis ke pesan paling bawah
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}


// ---------------------------------------------------------------------
// LANGKAH 4: Mengelola lampiran (foto / dokumen)
// ---------------------------------------------------------------------

// 4a. Tombol unggah tidak bisa langsung memilih file, jadi kita "klik"-kan
// input file yang tersembunyi.
attachButton.addEventListener('click', () => fileInput.click());

// 4b. Setelah pengguna memilih file, event 'change' terpanggil
fileInput.addEventListener('change', () => {
  const file = fileInput.files[0]; // ambil file pertama
  fileInput.value = '';            // reset, supaya file yang sama bisa dipilih lagi
  if (!file) return;

  // Cek jenis file
  if (!ALLOWED_TYPES.includes(file.type)) {
    enterChatMode();
    addMessage('error', 'Jenis file tidak didukung. Gunakan foto (JPG, PNG, WebP) atau dokumen (PDF, TXT).');
    return;
  }
  // Cek ukuran file (file.size dalam byte; 1 MB = 1024 * 1024 byte)
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    enterChatMode();
    addMessage('error', `Ukuran file terlalu besar (maksimal ${MAX_FILE_MB} MB).`);
    return;
  }

  selectedFile = file;
  showAttachmentPreview(file);
  heroInput.focus();
});

// 4c. Tampilkan pratinjau lampiran di atas kolom ketik
function showAttachmentPreview(file) {
  attachmentName.textContent = file.name;

  if (file.type.startsWith('image/')) {
    attachmentThumb.src = URL.createObjectURL(file);
    attachmentThumb.hidden = false;
    attachmentIcon.hidden = true;
  } else {
    attachmentThumb.hidden = true;
    attachmentIcon.hidden = false;
  }
  attachmentEl.hidden = false;
}

// 4d. Hapus lampiran yang sudah dipilih
function clearAttachment() {
  selectedFile = null;
  attachmentEl.hidden = true;
  attachmentThumb.removeAttribute('src');
}
removeAttachmentBtn.addEventListener('click', clearAttachment);


// ---------------------------------------------------------------------
// LANGKAH 5: Mengirim pesan ke backend (inti dari chatbot)
// ---------------------------------------------------------------------

// 5a. Ubah percakapan menjadi format riwayat yang diminta backend: { role, text }.
// File tidak ikut dikirim ulang (terlalu besar); cukup catatan teksnya.
// Kartu ringkasan tidak ikut dikirim karena bukan bagian dari obrolan.
function buildHistory() {
  const chat = conversation.filter((item) => item.role === 'user' || item.role === 'model');
  return chat.slice(-MAX_HISTORY).map((item) => ({
    role: item.role,
    text: item.attachment
      ? `[Melampirkan ${item.attachment.type.startsWith('image/') ? 'foto' : 'dokumen'}] ${item.text}`
      : item.text,
  }));
}

// async/await dipakai karena menunggu jawaban server butuh waktu.
// "await" = tunggu sampai selesai, baru lanjut ke baris berikutnya.
async function sendMessage(text) {
  text = text.trim();

  // 5b. Jangan kirim jika kosong (tanpa teks DAN tanpa file),
  // atau jika masih menunggu jawaban sebelumnya
  if ((!text && !selectedFile) || isSending) return;

  const file = selectedFile;
  const attachment = file ? { name: file.name, type: file.type } : null;
  const session = chatSession;

  // 5c. Pindah ke mode chat, tampilkan pesan pengguna, kosongkan lampiran
  enterChatMode();
  addMessage('user', text, { file });
  clearAttachment();
  stopListening();

  // Siapkan "remote" pembatal untuk tombol Stop
  currentController = new AbortController();
  setSending(true);
  let typingEl = showTyping();

  // 5d. Siapkan data yang dikirim.
  // FormData adalah format "form-data" — sama seperti tab form-data di Postman.
  // Format ini bisa membawa teks DAN file sekaligus.
  const formData = new FormData();
  formData.append('message', text);
  formData.append('history', JSON.stringify(buildHistory())); // array harus diubah jadi teks JSON
  if (selectedModel) {
    formData.append('model', selectedModel); // model pilihan dari dropdown (LANGKAH 10)
  }
  if (file) {
    formData.append('file', file); // nama field 'file' harus sama dengan upload.single('file') di backend
  }

  let replyText = '';  // jawaban yang terkumpul dari potongan-potongan stream
  let botMessage = null;
  let model = null;

  try {
    // 5e. Kirim ke backend. "?stream=1" meminta jawaban dikirim bertahap.
    // signal menghubungkan fetch dengan AbortController, sehingga
    // currentController.abort() akan membatalkannya.
    // Catatan: JANGAN isi header Content-Type secara manual untuk FormData;
    // browser akan mengisinya sendiri lengkap dengan "boundary" pemisah data.
    const response = await fetch('/api/chat?stream=1', {
      method: 'POST',
      body: formData,
      signal: currentController.signal,
    });

    // 5f. response.ok bernilai true jika status 200–299.
    // Selain itu (400, 413, 429, 503, ...) backend mengirim JSON { error: '...' }
    if (!response.ok) {
      const data = await response.json();
      addMessage('error', data.error || 'Terjadi kendala. Silakan coba lagi.');
      return; // berhenti di sini; percakapan tidak ditambah karena gagal
    }

    // 5g. Membaca jawaban streaming.
    // Server mengirim beberapa baris JSON (format NDJSON), satu baris per kejadian:
    //   {"type":"meta","model":"..."}   -> info model yang menjawab
    //   {"type":"chunk","text":"..."}   -> potongan jawaban (bisa banyak)
    //   {"type":"done"}                 -> jawaban selesai
    //   {"type":"error","error":"..."}  -> terputus di tengah jalan
    // response.body.getReader() membaca data begitu tiba, tanpa menunggu semuanya.
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); // mengubah byte menjadi teks
    let buffer = '';  // menampung baris yang belum lengkap
    let streamError = null;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // bagian terakhir mungkin belum lengkap, simpan dulu

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);

        if (event.type === 'meta') {
          model = event.model;
        } else if (event.type === 'chunk') {
          // Potongan pertama datang: ganti animasi mengetik dengan gelembung jawaban
          if (!botMessage) {
            removeTyping(typingEl);
            typingEl = null;
            botMessage = addMessage('bot', '');
          }
          replyText += event.text;
          botMessage.body.innerHTML = formatBotText(replyText);
          scrollToBottom();
        } else if (event.type === 'error') {
          streamError = event.error;
        }
      }
    }

    // 5h. Jawaban selesai (atau terputus di sisi server)
    if (streamError || !replyText) {
      addMessage('error', streamError || 'Maaf, saya belum dapat memberikan jawaban. Silakan coba lagi.');
    }
  } catch (error) {
    // 5i. catch menangkap dua jenis kejadian:
    //   - AbortError : pengguna menekan tombol Stop
    //   - lainnya    : error jaringan, misalnya server mati atau internet putus
    if (error.name === 'AbortError') {
      // Jika dibatalkan karena "Chat Baru", layar sudah dikosongkan — tidak perlu catatan
      if (session === chatSession) {
        addMessage('note', replyText ? 'Jawaban dihentikan.' : 'Permintaan dihentikan.');
      }
    } else {
      addMessage('error', 'Tidak dapat terhubung ke server. Pastikan server berjalan, lalu coba lagi.');
    }
  } finally {
    // 5j. finally SELALU dijalankan, berhasil maupun gagal:
    // hapus animasi mengetik (jika masih ada) dan kembalikan tombol kirim.
    removeTyping(typingEl);
    currentController = null;
    setSending(false);
    heroInput.focus();
  }

  // 5k. Jika ada jawaban (utuh atau sebagian), pasang tombol Salin & nama model,
  // lalu simpan ke percakapan supaya pertanyaan berikutnya nyambung.
  if (replyText && session === chatSession) {
    const finalText = replyText;
    addBotFooter(botMessage.bubble, model, () => finalText);
    conversation.push({ role: 'user', text, ...(attachment && { attachment }) });
    conversation.push({ role: 'model', text: finalText, model });
    saveConversation();
    updateSummaryBar(); // mungkin sudah cukup percakapan untuk dibuat ringkasan
  }
}

// 5l. Selama menunggu: tombol kirim diganti tombol Stop
function setSending(value) {
  isSending = value;
  sendButton.hidden = value;
  stopButton.hidden = !value;
  updateSummaryBar();
}

// Tombol Stop: batalkan fetch yang sedang berjalan.
// Backend juga ikut menghentikan permintaan ke Gemini (lihat streamReply di index.js).
stopButton.addEventListener('click', () => currentController?.abort());


// ---------------------------------------------------------------------
// LANGKAH 6: Hubungkan form dan tombol dengan fungsi di atas
// ---------------------------------------------------------------------

// 6a. Event 'submit' terjadi saat tombol kirim diklik ATAU Enter ditekan
heroForm.addEventListener('submit', (event) => {
  event.preventDefault(); // cegah halaman reload (perilaku bawaan form)
  const text = heroInput.value;
  if (!text.trim() && !selectedFile) return;
  heroInput.value = '';
  sendMessage(text);
});

// 6b. Tombol kategori: langsung kirim kalimat dari atribut data-prompt.
// (button.dataset.prompt membaca atribut data-prompt="..." di HTML)
chipButtons.forEach((button) => {
  button.addEventListener('click', () => sendMessage(button.dataset.prompt));
});


// ---------------------------------------------------------------------
// LANGKAH 7: Menyimpan percakapan agar tidak hilang saat refresh
// ---------------------------------------------------------------------
// sessionStorage = penyimpanan di browser yang OTOMATIS TERHAPUS saat tab
// ditutup. Cocok dengan aturan privasi: tidak ada penyimpanan permanen,
// dan tidak ada yang dikirim ke server. Isi file lampiran tidak disimpan,
// hanya nama dan jenisnya.
// Dibungkus try/catch karena penyimpanan browser bisa diblokir.
const CONVERSATION_KEY = 'tirta-percakapan';

function saveConversation() {
  try {
    sessionStorage.setItem(CONVERSATION_KEY, JSON.stringify(conversation));
  } catch {}
}

function loadConversation() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(CONVERSATION_KEY));
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
}

function clearSavedConversation() {
  try {
    sessionStorage.removeItem(CONVERSATION_KEY);
  } catch {}
}

// Saat halaman dibuka: tampilkan lagi percakapan yang tersimpan (jika ada)
function restoreConversation() {
  conversation = loadConversation();
  if (conversation.length === 0) return;

  enterChatMode();
  conversation.forEach((item) => {
    if (item.role === 'user') {
      addMessage('user', item.text, { attachment: item.attachment });
    } else if (item.role === 'summary') {
      renderSummaryCard(item);
    } else {
      const { bubble } = addMessage('bot', item.text);
      addBotFooter(bubble, item.model, () => item.text);
    }
  });
  updateSummaryBar();
}


// ---------------------------------------------------------------------
// LANGKAH 8: Input suara (bicara untuk mengetik)
// ---------------------------------------------------------------------
// Memakai Web Speech API bawaan browser (Chrome/Edge). Di browser yang
// tidak mendukung (misalnya Firefox), tombol mikrofon tetap disembunyikan.
// Catatan privasi: di Chrome, suara diproses oleh layanan Google untuk
// diubah menjadi teks.
const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;
let isListening = false;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = 'id-ID';          // Bahasa Indonesia
  recognition.interimResults = true;   // tampilkan teks sementara saat masih bicara
  recognition.continuous = false;      // berhenti otomatis saat pengguna diam

  let baseText = ''; // teks yang sudah ada di kolom sebelum mulai bicara

  recognition.addEventListener('start', () => {
    isListening = true;
    baseText = heroInput.value ? heroInput.value.trimEnd() + ' ' : '';
    micButton.classList.add('listening');
    micButton.setAttribute('aria-pressed', 'true');
    heroInput.placeholder = 'Silakan bicara…';
  });

  // Setiap kali ada hasil, gabungkan semua potongan kalimat ke kolom ketik.
  // Pesan TIDAK langsung dikirim — pengguna bisa memeriksa dulu, lalu tekan kirim.
  recognition.addEventListener('result', (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0].transcript)
      .join('');
    heroInput.value = baseText + transcript;
  });

  recognition.addEventListener('end', () => {
    isListening = false;
    micButton.classList.remove('listening');
    micButton.setAttribute('aria-pressed', 'false');
    heroInput.placeholder = 'Tulis keluhan Anda di sini...';
    heroInput.focus();
  });

  recognition.addEventListener('error', (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      enterChatMode();
      addMessage('error', 'Izin mikrofon ditolak. Aktifkan izin mikrofon di browser untuk memakai input suara.');
    }
  });

  micButton.hidden = false;
  micButton.addEventListener('click', () => {
    if (isListening) {
      recognition.stop();
    } else {
      recognition.start();
    }
  });
}

function stopListening() {
  if (isListening) recognition.stop();
}


// ---------------------------------------------------------------------
// LANGKAH 9: Mode chat, "Chat Baru", dan pindah halaman
// ---------------------------------------------------------------------

// 9a. Masuk mode chat: class 'chat-mode' dipakai CSS untuk menyembunyikan
// maskot/judul/kategori dan menampilkan daftar pesan di atas kolom ketik.
function enterChatMode() {
  if (isChatMode) return;
  isChatMode = true;
  stageEl.classList.add('chat-mode');
}

// 9b. Kembali ke tampilan awal dan mulai percakapan baru
function startNewChat() {
  chatSession += 1;
  if (isSending) currentController?.abort(); // hentikan jawaban yang sedang berjalan
  conversation = [];
  clearSavedConversation();
  clearAttachment();
  stopListening();
  heroInput.value = '';
  messagesEl.innerHTML = '';
  stageEl.classList.remove('chat-mode');
  isChatMode = false;
  updateSummaryBar();
}

// 9c. Pindah halaman tanpa reload: tampilkan satu, sembunyikan yang lain.
//   'chat'   -> tampilan chat
//   'guide'  -> halaman Panduan Kualitas Air
//   'outage' -> halaman Info Gangguan (simulasi)
function showView(view) {
  stageEl.hidden = view !== 'chat';
  guideEl.hidden = view !== 'guide';
  outageEl.hidden = view !== 'outage';

  // Tandai menu yang sedang aktif
  menuItems.forEach((item) => item.classList.toggle('active', item.dataset.view === view));

  if (view === 'guide') guideEl.scrollTop = 0;
  if (view === 'outage') {
    outageEl.scrollTop = 0;
    if (!outageLoaded) loadOutages(''); // tampilkan semua data saat pertama dibuka
  }
  if (view === 'chat') heroInput.focus();
}

newChatBtn.addEventListener('click', (event) => {
  event.preventDefault(); // href="#" jangan melompat ke atas halaman
  startNewChat();
  showView('chat');
});

openGuideBtn.addEventListener('click', (event) => {
  event.preventDefault();
  showView('guide');
});

openOutageBtn.addEventListener('click', (event) => {
  event.preventDefault();
  showView('outage');
});

// Tombol "Tanya Tirta" di halaman panduan: kembali ke chat tanpa menghapus percakapan
guideToChatBtn.addEventListener('click', () => showView('chat'));


// ---------------------------------------------------------------------
// LANGKAH 10: Pilihan model Gemini
// ---------------------------------------------------------------------
// Daftar model diambil dari backend (GET /api/models), yang membacanya dari
// GEMINI_MODEL_OPTIONS di .env. Jadi untuk menambah/mengurangi model cukup
// ubah .env — tidak perlu mengubah kode ini.
// Backend juga mengecek ulang: model di luar daftar akan ditolak.

const MODEL_STORAGE_KEY = 'tirta-model'; // kunci untuk mengingat pilihan di browser

// 10a. Nama yang lebih ramah untuk ditampilkan: "gemini-3.5-flash" -> "3.5 Flash"
function prettyModelName(model) {
  return model
    .replace(/^gemini-/, '')
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// 10b. Simpan & baca pilihan di localStorage supaya tetap terpilih setelah refresh.
// (localStorage tidak terhapus saat tab ditutup — cocok untuk preferensi seperti ini.)
function saveModelChoice(model) {
  try { localStorage.setItem(MODEL_STORAGE_KEY, model); } catch {}
}
function loadModelChoice() {
  try { return localStorage.getItem(MODEL_STORAGE_KEY); } catch { return null; }
}

// 10c. Pilih model: perbarui variabel, label tombol, dan tanda centang di menu
function selectModel(model) {
  selectedModel = model;
  modelLabel.textContent = `Tirta · ${prettyModelName(model)}`;
  modelMenu.querySelectorAll('[role="option"]').forEach((item) => {
    item.setAttribute('aria-selected', String(item.dataset.model === model));
  });
  saveModelChoice(model);
}

// 10d. Ambil daftar model dari backend, lalu buat isi menu
async function loadModels() {
  try {
    const response = await fetch('/api/models');
    const data = await response.json();

    data.models.forEach((model) => {
      const item = document.createElement('li');
      item.setAttribute('role', 'option');
      item.dataset.model = model;
      item.innerHTML = `<span class="model-name"></span><span class="model-id"></span>`;
      item.querySelector('.model-name').textContent = prettyModelName(model);
      item.querySelector('.model-id').textContent = model === data.default ? `${model} · default` : model;
      item.tabIndex = 0; // bisa dipilih dengan keyboard (Tab lalu Enter)
      item.addEventListener('click', () => {
        selectModel(model);
        closeModelMenu();
      });
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          item.click();
        }
      });
      modelMenu.appendChild(item);
    });

    // Pakai pilihan terakhir jika masih ada di daftar; jika tidak, pakai default
    const saved = loadModelChoice();
    selectModel(data.models.includes(saved) ? saved : data.default);
  } catch (error) {
    // Jika gagal, tombol tetap ada; server akan memakai model default
    modelLabel.textContent = 'Tirta · Default';
  }
}

// 10e. Buka/tutup menu
function openModelMenu() {
  modelMenu.hidden = false;
  modelButton.setAttribute('aria-expanded', 'true');
}
function closeModelMenu() {
  modelMenu.hidden = true;
  modelButton.setAttribute('aria-expanded', 'false');
}

modelButton.addEventListener('click', (event) => {
  event.stopPropagation(); // supaya klik ini tidak dianggap "klik di luar menu"
  modelMenu.hidden ? openModelMenu() : closeModelMenu();
});

// Klik di mana saja di luar menu atau tekan Esc -> menu tertutup
document.addEventListener('click', (event) => {
  if (!modelMenu.hidden && !modelMenu.contains(event.target)) closeModelMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModelMenu();
});


// ---------------------------------------------------------------------
// LANGKAH 11: Ringkasan laporan keluhan
// ---------------------------------------------------------------------
// Alurnya:
//   klik "Buat ringkasan laporan"
//     -> kirim riwayat percakapan ke POST /api/summary
//     -> backend meminta Gemini mengisi kolom-kolom tetap (format JSON)
//     -> tampilkan sebagai kartu, lengkap dengan tombol Salin, Unduh, dan Edit

const BELUM_DIKETAHUI = 'Belum diketahui';
const MIN_USER_TURNS = 2; // tombol muncul setelah pengguna mengirim minimal 2 pesan

// Label kolom; urutan dan nama kunci harus sama dengan KOLOM_RINGKASAN di backend
const SUMMARY_LABELS = {
  jenis_keluhan: 'Jenis keluhan',
  wilayah: 'Wilayah',
  mulai_terjadi: 'Mulai terjadi',
  cakupan: 'Cakupan',
  pengamatan: 'Pengamatan',
  langkah_dilakukan: 'Langkah yang sudah dilakukan',
};

// 11a. Tampilkan tombol ringkasan hanya jika sudah ada cukup percakapan
function updateSummaryBar() {
  const userTurns = conversation.filter((item) => item.role === 'user').length;
  summaryBar.hidden = !isChatMode || isSending || userTurns < MIN_USER_TURNS;
}

// 11b. Hitung lampiran yang pernah dikirim, misalnya "1 foto, 1 dokumen"
function describeAttachments() {
  const files = conversation.filter((item) => item.attachment).map((item) => item.attachment);
  const photos = files.filter((f) => f.type.startsWith('image/')).length;
  const docs = files.length - photos;
  const parts = [];
  if (photos) parts.push(`${photos} foto`);
  if (docs) parts.push(`${docs} dokumen`);
  return parts.length ? parts.join(', ') : 'Tidak ada';
}

// 11c. Format tanggal Indonesia, misalnya "28 Oktober 2026, 14.30"
function formatDate(iso) {
  return new Date(iso).toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' });
}

// 11d. Ubah ringkasan menjadi teks biasa (untuk Salin dan Unduh)
function summaryToText(item) {
  const lines = [
    'RINGKASAN LAPORAN KELUHAN KUALITAS AIR',
    `Dibuat: ${formatDate(item.createdAt)}`,
    'Disusun dengan bantuan AI (Tirta). Periksa kembali sebelum dikirim.',
    '',
    ...Object.entries(SUMMARY_LABELS).map(([key, label]) => `${label}: ${item.data[key] || BELUM_DIKETAHUI}`),
    `Lampiran: ${item.attachments}`,
    '',
    'Catatan: Ringkasan ini bukan laporan resmi. Kirimkan ke kanal pengaduan resmi PDAM setempat.',
  ];
  return lines.join('\n');
}

// 11e. Unduh teks sebagai file .txt.
// Blob = "file" yang dibuat di memori browser; link sementara lalu diklik otomatis.
function downloadText(text, filename) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url); // bersihkan link sementara
}

// 11f. Membuat tombol kecil untuk kartu (dipakai Salin, Unduh, Edit)
function makeCardButton(text, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'card-btn';
  button.textContent = text;
  button.addEventListener('click', onClick);
  return button;
}

// 11g. Menampilkan kartu ringkasan di dalam percakapan.
// Semua isi dimasukkan dengan textContent, jadi aman dari XSS.
function renderSummaryCard(item) {
  const card = document.createElement('section');
  card.className = 'summary-card';
  card.setAttribute('aria-label', 'Ringkasan laporan keluhan');

  // Judul
  const head = document.createElement('header');
  head.innerHTML = '<h3></h3><p></p>';
  head.querySelector('h3').textContent = '📋 Ringkasan Laporan Keluhan Kualitas Air';
  head.querySelector('p').textContent = `Disusun oleh AI · periksa sebelum dikirim · ${formatDate(item.createdAt)}`;
  card.appendChild(head);

  // Isi: daftar label-nilai menggunakan <dl> (description list)
  const list = document.createElement('dl');
  const valueEls = {}; // disimpan supaya bisa diedit
  Object.entries(SUMMARY_LABELS).forEach(([key, label]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = item.data[key] || BELUM_DIKETAHUI;
    dd.classList.toggle('unknown', dd.textContent === BELUM_DIKETAHUI);
    valueEls[key] = dd;
    list.append(dt, dd);
  });
  const dtFile = document.createElement('dt');
  dtFile.textContent = 'Lampiran';
  const ddFile = document.createElement('dd');
  ddFile.textContent = item.attachments;
  list.append(dtFile, ddFile);
  card.appendChild(list);

  // Tombol-tombol
  const actions = document.createElement('div');
  actions.className = 'summary-actions';

  const copyBtn = makeCardButton('Salin', async () => {
    try {
      await navigator.clipboard.writeText(summaryToText(item));
      copyBtn.textContent = 'Tersalin ✓';
    } catch {
      copyBtn.textContent = 'Gagal menyalin';
    }
    setTimeout(() => (copyBtn.textContent = 'Salin'), 2000);
  });

  const downloadBtn = makeCardButton('Unduh .txt', () => {
    const date = item.createdAt.slice(0, 10); // "2026-10-28"
    downloadText(summaryToText(item), `ringkasan-laporan-kualitas-air-${date}.txt`);
  });

  // Edit: isi kolom bisa diketik langsung (contentEditable), lalu disimpan
  const editBtn = makeCardButton('Edit', () => {
    const editing = card.classList.toggle('editing');
    Object.entries(valueEls).forEach(([key, dd]) => {
      dd.contentEditable = String(editing);
      if (!editing) {
        // Selesai mengedit: simpan teks baru ke data ringkasan
        item.data[key] = dd.textContent.trim() || BELUM_DIKETAHUI;
        dd.textContent = item.data[key];
        dd.classList.toggle('unknown', item.data[key] === BELUM_DIKETAHUI);
      }
    });
    editBtn.textContent = editing ? 'Selesai' : 'Edit';
    if (editing) valueEls.jenis_keluhan.focus();
    else saveConversation();
  });

  actions.append(copyBtn, downloadBtn, editBtn);
  card.appendChild(actions);

  // Pengingat: ini bukan laporan resmi
  const note = document.createElement('p');
  note.className = 'summary-note';
  note.textContent = 'Ringkasan ini bukan laporan resmi. Kirimkan ke kanal pengaduan resmi PDAM setempat.';
  card.appendChild(note);

  messagesEl.appendChild(card);
  scrollToBottom();
}

// 11h. Minta ringkasan ke backend
async function createSummary() {
  if (isSending) return;
  const session = chatSession;

  currentController = new AbortController();
  setSending(true);
  const typingEl = showTyping();

  try {
    const response = await fetch('/api/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // body berupa JSON (bukan FormData)
      body: JSON.stringify({ history: buildHistory(), ...(selectedModel && { model: selectedModel }) }),
      signal: currentController.signal,
    });
    const data = await response.json();

    if (!response.ok) {
      addMessage('error', data.error || 'Ringkasan belum dapat dibuat. Silakan coba lagi.');
      return;
    }
    if (session !== chatSession) return; // pengguna sudah memulai chat baru

    const item = {
      role: 'summary',
      data: data.ringkasan,
      model: data.model,
      createdAt: new Date().toISOString(),
      attachments: describeAttachments(),
    };
    conversation.push(item);
    saveConversation();
    removeTyping(typingEl);
    renderSummaryCard(item);
  } catch (error) {
    if (error.name === 'AbortError') {
      if (session === chatSession) addMessage('note', 'Pembuatan ringkasan dihentikan.');
    } else {
      addMessage('error', 'Tidak dapat terhubung ke server. Pastikan server berjalan, lalu coba lagi.');
    }
  } finally {
    removeTyping(typingEl);
    currentController = null;
    setSending(false);
  }
}

summaryButton.addEventListener('click', createSummary);


// ---------------------------------------------------------------------
// LANGKAH 12: Info Gangguan (DATA SIMULASI)
// ---------------------------------------------------------------------
// Data diambil dari GET /api/gangguan?wilayah=..., yang membaca
// data/gangguan-dummy.json di server. Semua kartu WAJIB berlabel SIMULASI
// supaya tidak disangka informasi resmi.

let outageLoaded = false; // data sudah pernah dimuat?

// 12a. Warna penanda untuk setiap tahap
const TAHAP_CLASS = {
  'Dalam penanganan': 'tahap-proses',
  Terjadwal: 'tahap-jadwal',
  Selesai: 'tahap-selesai',
};

// 12b. Membuat satu kartu gangguan (semua isi lewat textContent -> aman dari XSS)
function renderOutageCard(item) {
  const card = document.createElement('article');
  card.className = 'outage-card';

  const top = document.createElement('div');
  top.className = 'outage-top';
  const id = document.createElement('span');
  id.className = 'outage-id';
  id.textContent = item.id;
  const badge = document.createElement('span');
  badge.className = 'sim-badge';
  badge.textContent = 'SIMULASI';
  top.append(id, badge);

  const title = document.createElement('h3');
  title.textContent = item.wilayah;
  const area = document.createElement('p');
  area.className = 'outage-area';
  area.textContent = item.kecamatan;

  const type = document.createElement('p');
  type.className = 'outage-type';
  type.textContent = item.jenis_gangguan;

  const impact = document.createElement('p');
  impact.className = 'outage-impact';
  impact.textContent = item.dampak;

  const meta = document.createElement('div');
  meta.className = 'outage-meta';
  const tahap = document.createElement('span');
  tahap.className = `tahap ${TAHAP_CLASS[item.tahap] ?? ''}`;
  tahap.textContent = `${item.tahap} (simulasi)`;
  const time = document.createElement('span');
  time.textContent = `Mulai: ${formatDate(item.waktu_mulai)}`;
  meta.append(tahap, time);

  card.append(top, title, area, type, impact, meta);
  return card;
}

// 12c. Ambil data dari backend lalu tampilkan
async function loadOutages(wilayah) {
  outageCount.textContent = 'Memuat data…';
  outageList.innerHTML = '';

  try {
    // encodeURIComponent mengamankan teks agar aman dipakai di URL (spasi, simbol, dll.)
    const response = await fetch(`/api/gangguan?wilayah=${encodeURIComponent(wilayah)}`);
    const data = await response.json();
    if (!response.ok) {
      outageCount.textContent = data.error || 'Data belum dapat dimuat.';
      return;
    }
    outageLoaded = true;

    if (data.data.length === 0) {
      // Tidak ada data BUKAN berarti tidak ada gangguan — sampaikan dengan jelas
      outageCount.textContent = `Tidak ada data simulasi untuk "${wilayah}". Ini tidak berarti tidak ada gangguan di wilayah tersebut.`;
      return;
    }

    outageCount.textContent = wilayah
      ? `${data.data.length} data simulasi untuk "${wilayah}"`
      : `Menampilkan ${data.data.length} data simulasi`;
    data.data.forEach((item) => outageList.appendChild(renderOutageCard(item)));
  } catch {
    outageCount.textContent = 'Tidak dapat terhubung ke server. Pastikan server berjalan, lalu coba lagi.';
  }
}

// 12d. Pencarian: saat form dikirim (Enter / tombol Cari)
outageForm.addEventListener('submit', (event) => {
  event.preventDefault();
  loadOutages(outageInput.value.trim());
});

// Saat kolom pencarian dikosongkan (misalnya tombol ×), tampilkan semua lagi
outageInput.addEventListener('search', () => {
  if (outageInput.value === '') loadOutages('');
});


// ---------------------------------------------------------------------
// LANGKAH 13: Jalankan saat halaman pertama kali dibuka
// ---------------------------------------------------------------------
loadModels();
restoreConversation();
