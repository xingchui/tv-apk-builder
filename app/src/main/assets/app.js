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

// --- CORS Proxy Config ---
// Used when native bridge is unavailable (browser testing).
// Set to an empty string to bypass and fetch directly.
const CORS_PROXY_BASE = 'https://api.allorigins.win/raw?url=';

async function proxyFetch(url) {
  if (CORS_PROXY_BASE) {
    const resp = await fetch(CORS_PROXY_BASE + encodeURIComponent(url));
    if (!resp.ok) throw new Error('Proxy fetch failed: ' + resp.status);
    return await resp.text();
  }
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('Fetch failed: ' + resp.status);
  return await resp.text();
}

// --- Browser Fallback (uses fetch + DOMParser) ---

const BASE_URL = 'https://www.ikanbot.com';

function computeToken(currentId, eToken) {
  // Same algorithm as WebAppInterface.computeToken()
  let suffix = currentId.slice(-4);
  let result = '';
  let remaining = eToken;
  for (let i = 0; i < suffix.length; i++) {
    let digit = parseInt(suffix[i], 10);
    let offset = (digit % 3) + 1;
    if (offset + 8 > remaining.length) break;
    result += remaining.substring(offset, offset + 8);
    remaining = remaining.substring(offset + 8);
  }
  return result;
}

async function browserSearch(query) {
  let encoded = encodeURIComponent(query.trim());
  let url = BASE_URL + '/search?q=' + encoded;
  console.log('[Browser] Searching:', url);

  let html = await proxyFetch(url);
  let parser = new DOMParser();
  let doc = parser.parseFromString(html, 'text/html');

  let results = [];
  let mediaItems = doc.querySelectorAll('div.media');
  console.log('[Browser] Found', mediaItems.length, 'media items');

  for (let media of mediaItems) {
    let coverLink = media.querySelector('a.cover-link');
    if (!coverLink) continue;
    let href = coverLink.getAttribute('href') || '';
    if (!href) continue;
    let fullUrl = href.startsWith('http') ? href : BASE_URL + href;

    let titleEl = media.querySelector('a.title-text');
    let title = titleEl ? titleEl.textContent.trim() : '';
    if (!title) continue;
    if (title.length > 100) title = title.substring(0, 100);

    let thumbnail = '';
    let img = media.querySelector('img.media-pic.lazy');
    if (img) {
      thumbnail = img.getAttribute('data-src') || img.getAttribute('src') || '';
      if (thumbnail && !thumbnail.startsWith('http')) {
        if (thumbnail.startsWith('//')) {
          thumbnail = 'https:' + thumbnail;
        } else if (!thumbnail.startsWith('data:')) {
          thumbnail = 'https:' + thumbnail;
        }
      }
    }

    let episodes = '';
    let epEl = media.querySelector('span.label');
    if (epEl) episodes = epEl.textContent.trim();

    results.push({ title, url: fullUrl, thumbnail, episodes });
    if (results.length >= 20) break;
  }

  return { results };
}

async function browserGetPlayInfo(pageUrl) {
  console.log('[Browser] Fetching play page:', pageUrl);

  let html = await proxyFetch(pageUrl);
  let parser = new DOMParser();
  let doc = parser.parseFromString(html, 'text/html');

  let currentId = (doc.querySelector('#current_id') || {}).value || '';
  let mtype = (doc.querySelector('#mtype') || {}).value || '';
  let eToken = (doc.querySelector('#e_token') || {}).value || '';

  if (!currentId || !eToken) {
    console.warn('[Browser] Missing hidden inputs');
    return { videos: [] };
  }

  console.log('[Browser] currentId:', currentId, 'mtype:', mtype, 'eToken length:', eToken.length);

  let token = computeToken(currentId, eToken);
  console.log('[Browser] Computed token:', token);

  let apiUrl = BASE_URL + '/api/getResN?videoId=' + currentId
    + '&mtype=' + (mtype || '1')
    + '&token=' + token;
  console.log('[Browser] API URL:', apiUrl);

  let apiResponse = await proxyFetch(apiUrl);
  console.log('[Browser] API response:', apiResponse.substring(0, 200));

  let responseJson = JSON.parse(apiResponse);
  if (responseJson.state !== 1) {
    console.warn('[Browser] API state:', responseJson.state);
    return { videos: [] };
  }

  let videos = [];
  let dataObj = responseJson.data;
  if (dataObj && dataObj.list) {
    for (let lineItem of dataObj.list) {
      let resDataStr = lineItem.resData || '';
      if (!resDataStr) continue;

      try {
        let resArray = JSON.parse(resDataStr);
        for (let resObj of resArray) {
          let urlData = resObj.url || '';
          if (!urlData) continue;

          let entries = urlData.split('#');
          for (let entry of entries) {
            let parts = entry.split('$');
            if (parts.length >= 2) {
              let label = parts[0].trim();
              let videoUrl = parts.slice(1).join('$').trim();
              if (videoUrl.toLowerCase().endsWith('.m3u8')) {
                videos.push({
                  url: videoUrl,
                  label: label || ('线路 ' + (videos.length + 1))
                });
              }
            }
          }
        }
      } catch (e) {
        // regex fallback for m3u8 URLs
        console.warn('[Browser] resData parse failed, regex fallback', e);
        let m3u8Regex = /https?:\/\/[^"'\s,]+?\.m3u8[^"'\s,]*/g;
        let match;
        while ((match = m3u8Regex.exec(resDataStr)) !== null) {
          let m3u8Url = match[0];
          if (!videos.some(v => v.url === m3u8Url)) {
            videos.push({ url: m3u8Url, label: '视频源 ' + (videos.length + 1) });
          }
        }
      }
    }
  }

  return { videos };
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
    let data;
    if (bridgeAvailable()) {
      let raw = nativeSearch(query);
      if (raw) {
        data = JSON.parse(raw);
      } else {
        showToast('Native 搜索返回空');
        loadingIndicator.classList.add('hidden');
        return;
      }
    } else {
      data = await browserSearch(query);
    }

    if (data.error) {
      showToast('搜索失败: ' + data.error);
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

async function openDetail(idx) {
  let item = currentResults[idx];
  if (!item) return;

  let detailUrl = item.url;
  if (!detailUrl) { showToast('无播放链接'); return; }

  loadingIndicator.classList.remove('hidden');

  try {
    let data;
    if (bridgeAvailable()) {
      let raw = nativeGetPlayInfo(detailUrl);
      if (raw) {
        data = JSON.parse(raw);
      } else {
        showToast('Native 获取信息返回空');
        loadingIndicator.classList.add('hidden');
        return;
      }
    } else {
      data = await browserGetPlayInfo(detailUrl);
    }

    if (data.error) {
      showToast('获取播放信息失败: ' + data.error);
      loadingIndicator.classList.add('hidden');
      return;
    }
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
