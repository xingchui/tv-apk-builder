/* ============================================================
   app.js — TV Search & Playback
   ============================================================ */

// --- State ---
let currentResults = [];
let searchInputEl = document.getElementById('searchInput');
let searchBtnEl = document.getElementById('searchBtn');
let resultsContainer = document.getElementById('resultsContainer');
let emptyState = document.getElementById('emptyState');
let loadingIndicator = document.getElementById('loadingIndicator');
let searchScreen = document.getElementById('searchScreen');
let playerScreen = document.getElementById('playerScreen');
let videoPlayer = document.getElementById('videoPlayer');
let backBtn = document.getElementById('backBtn');
let playerTitle = document.getElementById('playerTitle');
let toast = document.getElementById('toast');
let hlsInstance = null;

// --- Focus Management ---
let focusedIndex = -1;

// --- Native Bridge ---
function bridgeAvailable() {
  return typeof Android !== 'undefined' && Android !== null;
}

function nativeSearch(query) {
  if (bridgeAvailable()) {
    return Android.search(query);
  }
  return null;
}

function nativeGetPlayInfo(url) {
  if (bridgeAvailable()) {
    return Android.getPlayInfo(url);
  }
  return null;
}

// --- Toast ---
let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// --- Search ---
async function performSearch() {
  let query = searchInputEl.value.trim();
  if (!query) { showToast('请输入搜索关键词'); return; }

  emptyState.classList.add('hidden');
  loadingIndicator.classList.remove('hidden');
  resultsContainer.innerHTML = '';
  resultsContainer.classList.remove('has-results');

  try {
    let raw = nativeSearch(query);
    let data;
    if (raw) {
      data = JSON.parse(raw);
    } else {
      showToast('无法连接 native 层');
      loadingIndicator.classList.add('hidden');
      return;
    }

    if (!data || !data.results || data.results.length === 0) {
      emptyState.classList.remove('hidden');
      emptyState.innerHTML = '<p>未找到结果</p>';
      loadingIndicator.classList.add('hidden');
      return;
    }

    currentResults = data.results;
    renderResults(currentResults);
  } catch (e) {
    showToast('搜索失败: ' + e.message);
  }
  loadingIndicator.classList.add('hidden');
}

function renderResults(results) {
  resultsContainer.innerHTML = '';
  resultsContainer.classList.add('has-results');

  results.forEach((item, idx) => {
    let card = document.createElement('div');
    card.className = 'result-card';
    card.tabIndex = 0;
    card.dataset.index = idx;

    let imgUrl = item.thumbnail || '';
    let title = item.title || '未知';
    let episodes = item.episodes || '';

    card.innerHTML = `
      <div class="card-thumb">
        ${imgUrl ? '<img src="' + escapeHtml(imgUrl) + '" alt="" loading="lazy" onerror="this.style.display=\'none\'">' : '<div class="card-placeholder">🎬</div>'}
      </div>
      <div class="card-info">
        <div class="card-title">${escapeHtml(title)}</div>
        ${episodes ? '<div class="card-episodes">' + escapeHtml(episodes) + '</div>' : ''}
      </div>
    `;

    card.addEventListener('click', () => openDetail(idx));
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openDetail(idx);
      }
    });

    resultsContainer.appendChild(card);
  });

  // Focus first card
  focusedIndex = 0;
  let cards = resultsContainer.querySelectorAll('.result-card');
  if (cards.length > 0) setTimeout(() => cards[0].focus(), 100);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// --- Detail / Play ---
let currentDetailVideos = [];

function openDetail(idx) {
  let item = currentResults[idx];
  if (!item) return;

  let detailUrl = item.url;
  if (!detailUrl) { showToast('无播放链接'); return; }

  loadingIndicator.classList.remove('hidden');

  try {
    let raw = nativeGetPlayInfo(detailUrl);
    if (!raw) { showToast('获取播放信息失败'); loadingIndicator.classList.add('hidden'); return; }

    let data = JSON.parse(raw);

    if (!data.videos || data.videos.length === 0) {
      showToast('未找到视频源');
      loadingIndicator.classList.add('hidden');
      return;
    }

    currentDetailVideos = data.videos;
    // Play the first video
    let first = currentDetailVideos[0];
    playVideo(first.url, first.label || item.title);

  } catch (e) {
    showToast('解析失败: ' + e.message);
  }
  loadingIndicator.classList.add('hidden');
}

function playVideo(url, title) {
  // Switch to player screen
  searchScreen.classList.remove('active');
  playerScreen.classList.add('active');
  playerTitle.textContent = title || '';

  // Focus the back button for DPad navigation on Android TV
  setTimeout(() => backBtn.focus(), 200);

  // Clean up old HLS instance
  if (hlsInstance) {
    hlsInstance.destroy();
    hlsInstance = null;
  }

  if (url.endsWith('.m3u8')) {
    if (Hls.isSupported()) {
      hlsInstance = new Hls();
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(videoPlayer);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        videoPlayer.play().catch(e => console.warn('play failed', e));
      });
      hlsInstance.on(Hls.Events.ERROR, (e, data) => {
        if (data.fatal) {
          showToast('播放出错');
        }
      });
    } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari / some WebViews)
      videoPlayer.src = url;
      videoPlayer.play().catch(e => console.warn('play failed', e));
    } else {
      showToast('当前设备不支持 HLS 播放');
    }
  } else {
    videoPlayer.src = url;
    videoPlayer.play().catch(e => console.warn('play failed', e));
  }
}

// --- Back ---
backBtn.addEventListener('click', exitPlayer);
backBtn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); exitPlayer(); }
});

function exitPlayer() {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  videoPlayer.pause();
  videoPlayer.src = '';
  playerScreen.classList.remove('active');
  searchScreen.classList.add('active');
  // Refocus search
  searchInputEl.focus();
}

// --- Android TV Back Key ---
document.addEventListener('keydown', (e) => {
  if (e.key === 'Back' || e.key === 'Escape') {
    if (playerScreen.classList.contains('active')) {
      e.preventDefault();
      exitPlayer();
    } else if (bridgeAvailable()) {
      // On search screen — exit the app
      Android.exitApp();
    }
  }
});

// --- DPad Navigation for Player Screen ---
document.addEventListener('keydown', (e) => {
  if (!playerScreen.classList.contains('active')) return;

  // Only handle when backBtn is a possible focus target
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    backBtn.focus();
  }
});

// --- DPad Navigation for Results ---
document.addEventListener('keydown', (e) => {
  if (!searchScreen.classList.contains('active')) return;
  if (loadingIndicator.classList.contains('hidden') === false) return;

  let cards = resultsContainer.querySelectorAll('.result-card');
  if (cards.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusedIndex = Math.min(focusedIndex + 1, cards.length - 1);
    cards[focusedIndex].focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusedIndex = Math.max(focusedIndex - 1, 0);
    cards[focusedIndex].focus();
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    // Row navigation: assume 5 items per row
    e.preventDefault();
    let cols = 5;
    let row = Math.floor(focusedIndex / cols);
    let col = focusedIndex % cols;
    if (e.key === 'ArrowRight') {
      col = Math.min(col + 1, cols - 1);
    } else {
      col = Math.max(col - 1, 0);
    }
    let newIdx = row * cols + col;
    if (newIdx >= cards.length) newIdx = cards.length - 1;
    focusedIndex = newIdx;
    cards[focusedIndex].focus();
  }
});

// --- Search Events ---
searchBtnEl.addEventListener('click', performSearch);
searchBtnEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); performSearch(); }
});
searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); performSearch(); }
});

// Initial focus
window.addEventListener('load', () => {
  searchInputEl.focus();
});
