/* ============================================================
   app.js — TV Search & Playback
   ============================================================ */

// --- State ---
let currentResults = [];
let currentDetailData = null;        // {type:"movie"|"tv", lines:[{name, items:[{label,url}]}]}
let currentDetailTitle = '';
let currentLineIndex = -1;           // -1 = line list, >=0 = episode list for that line

let searchInputEl = document.getElementById('searchInput');
let searchBtnEl = document.getElementById('searchBtn');
let resultsContainer = document.getElementById('resultsContainer');
let emptyState = document.getElementById('emptyState');
let loadingIndicator = document.getElementById('loadingIndicator');
let searchScreen = document.getElementById('searchScreen');
let sourceScreen = document.getElementById('sourceScreen');
let playerScreen = document.getElementById('playerScreen');
let videoPlayer = document.getElementById('videoPlayer');
let backBtn = document.getElementById('backBtn');
let sourceBackBtn = document.getElementById('sourceBackBtn');
let sourceTitle = document.getElementById('sourceTitle');
let sourceCount = document.getElementById('sourceCount');
let sourceList = document.getElementById('sourceList');
let sourceEmpty = document.getElementById('sourceEmpty');
let playerTitle = document.getElementById('playerTitle');
let toast = document.getElementById('toast');
let hlsInstance = null;

// --- Player Controls State ---
let controlsTimer = null;

// --- Focus Management ---
let focusedIndex = -1;
let focusSourceIndex = -1;

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

// --- Local Proxy Config ---
// When native bridge is unavailable (browser testing), the app tries:
//   1. Local proxy at LOCAL_PROXY (recommended — run: node scraping-proxy.mjs)
//   2. External CORS proxy as fallback
const CORS_PROXY_BASE = ''; // Optional CORS proxy URL, e.g. 'https://api.allorigins.win/raw?url='

async function localProxySearch(query) {
  let resp = await fetch('/api/search?q=' + encodeURIComponent(query));
  if (!resp.ok) throw new Error('Local proxy search failed: ' + resp.status);
  return await resp.json();
}

async function localProxyGetPlayInfo(pageUrl) {
  let resp = await fetch('/api/play?url=' + encodeURIComponent(pageUrl));
  if (!resp.ok) throw new Error('Local proxy play failed: ' + resp.status);
  return await resp.json();
}

// --- External CORS Proxy Fallback (DOMParser-based) ---

const BASE_URL = 'https://www.ikanbot.com';

function computeToken(currentId, eToken) {
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

async function proxyFetch(url) {
  if (!CORS_PROXY_BASE) throw new Error('No CORS proxy configured');
  const resp = await fetch(CORS_PROXY_BASE + encodeURIComponent(url));
  if (!resp.ok) throw new Error('Proxy fetch failed: ' + resp.status);
  return await resp.text();
}

async function corsProxySearch(query) {
  let encoded = encodeURIComponent(query.trim());
  let html = await proxyFetch(BASE_URL + '/search?q=' + encoded);
  let parser = new DOMParser();
  let doc = parser.parseFromString(html, 'text/html');

  let results = [];
  let mediaItems = doc.querySelectorAll('div.media');

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

async function corsProxyGetPlayInfo(pageUrl) {
  let html = await proxyFetch(pageUrl);
  let parser = new DOMParser();
  let doc = parser.parseFromString(html, 'text/html');

  let currentId = (doc.querySelector('#current_id') || {}).value || '';
  let mtype = (doc.querySelector('#mtype') || {}).value || '';
  let eToken = (doc.querySelector('#e_token') || {}).value || '';

  if (!currentId || !eToken) return { type: 'movie', lines: [] };

  let token = computeToken(currentId, eToken);
  let apiUrl = BASE_URL + '/api/getResN?videoId=' + currentId
    + '&mtype=' + (mtype || '1')
    + '&token=' + token;

  let apiResponse = await proxyFetch(apiUrl);
  let responseJson = JSON.parse(apiResponse);
  if (responseJson.state !== 1) return { type: 'movie', lines: [] };

  let mediaType = mtype === '2' ? 'tv' : 'movie';
  let lines = [];
  let dataObj = responseJson.data;
  if (dataObj && dataObj.list) {
    for (let lineIdx = 0; lineIdx < dataObj.list.length; lineIdx++) {
      let lineItem = dataObj.list[lineIdx];
      let resDataStr = lineItem.resData || '';
      if (!resDataStr) continue;
      let items = [];
      try {
        let resArray = JSON.parse(resDataStr);
        for (let resObj of resArray) {
          let urlData = resObj.url || '';
          if (!urlData) continue;
          for (let entry of urlData.split('#')) {
            let parts = entry.split('$');
            if (parts.length >= 2) {
              let label = parts[0].trim();
              let videoUrl = parts.slice(1).join('$').trim();
              if (videoUrl.toLowerCase().endsWith('.m3u8')) {
                items.push({ url: videoUrl, label: label });
              }
            }
          }
        }
      } catch (e) {
        let m3u8Regex = /https?:\/\/[^"'\s,]+?\.m3u8[^"'\s,]*/g;
        let match;
        while ((match = m3u8Regex.exec(resDataStr)) !== null) {
          if (!items.some(v => v.url === match[0])) {
            items.push({ url: match[0], label: '视频源 ' + (items.length + 1) });
          }
        }
      }
      if (items.length > 0) {
        lines.push({ name: '线路' + (lineIdx + 1), items: items });
      }
    }
  }
  return { type: mediaType, lines: lines };
}

async function browserSearch(query) {
  // Try local proxy first, fall back to CORS proxy
  try {
    return await localProxySearch(query);
  } catch (e1) {
    console.warn('[Browser] Local proxy unavailable, trying CORS proxy:', e1.message);
    if (CORS_PROXY_BASE) return await corsProxySearch(query);
    throw new Error('Local proxy not running. Run: python local-server.py');
  }
}

async function browserGetPlayInfo(pageUrl) {
  // Try local proxy first, fall back to CORS proxy
  try {
    return await localProxyGetPlayInfo(pageUrl);
  } catch (e1) {
    console.warn('[Browser] Local proxy unavailable, trying CORS proxy:', e1.message);
    if (CORS_PROXY_BASE) return await corsProxyGetPlayInfo(pageUrl);
    throw new Error('Local proxy not running. Run: python local-server.py');
  }
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

// --- Detail / Source Selection ---

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
      if (raw) data = JSON.parse(raw);
      else { showToast('Native 获取信息返回空'); loadingIndicator.classList.add('hidden'); return; }
    } else {
      data = await browserGetPlayInfo(detailUrl);
    }

    if (data.error) { showToast('获取播放信息失败: ' + data.error); loadingIndicator.classList.add('hidden'); return; }
    if (!data.lines || data.lines.length === 0) { showToast('未找到视频源'); loadingIndicator.classList.add('hidden'); return; }

    // Debug: log received data structure
    console.log('[openDetail] type=' + data.type + ', lines=' + data.lines.length);
    if (data.lines) {
      for (let li = 0; li < data.lines.length; li++) {
        let l = data.lines[li];
        console.log('[openDetail]   line ' + (li+1) + ': "' + l.name + '" items=' + (l.items ? l.items.length : 0));
      }
    }

    currentDetailData = data;
    currentDetailTitle = item.title;
    currentLineIndex = -1;
    showSourceSelection();
  } catch (e) {
    showToast('解析失败: ' + e.message);
  }
  loadingIndicator.classList.add('hidden');
}

function showSourceSelection() {
  sourceList.innerHTML = '';
  sourceEmpty.classList.add('hidden');

  let data = currentDetailData;
  sourceTitle.textContent = currentDetailTitle;

  // Update dynamic text based on view mode
  let promptText = document.getElementById('promptText');
  let promptHint = document.getElementById('promptHint');
  let backLabel = document.querySelector('.source-back-btn .back-label');
  let isEpisodeView = (data && data.type === 'tv' && currentLineIndex >= 0);

  if (promptText) promptText.textContent = isEpisodeView ? '请选择剧集' : '请选择播放线路';
  if (promptHint) promptHint.textContent = isEpisodeView ? '按 ← 返回线路列表' : '按 ← 返回搜索结果';
  if (backLabel) backLabel.textContent = isEpisodeView ? '返回线路' : '返回搜索';

  if (!data || !data.lines || data.lines.length === 0) {
    sourceCount.textContent = '0 个线路';
    sourceEmpty.classList.remove('hidden');
    searchScreen.classList.remove('active');
    sourceScreen.classList.add('active');
    return;
  }

  if (data.type === 'movie') {
    // Movie: flatten all items with "线路N: label"
    let totalItems = 0;
    for (let line of data.lines) totalItems += line.items.length;
    sourceCount.textContent = totalItems + ' 个播放源';

    for (let li = 0; li < data.lines.length; li++) {
      let line = data.lines[li];
      for (let ii = 0; ii < line.items.length; ii++) {
        let item = line.items[ii];
        let el = document.createElement('div');
        el.className = 'source-item';
        el.tabIndex = 0;
        let label = '线路' + (li + 1) + ': ' + item.label;
        el.innerHTML = `
          <span class="source-item-icon">▶</span>
          <span class="source-item-label">${escapeHtml(label)}</span>
          <span class="source-item-index">${li + 1} / ${data.lines.length}</span>
        `;
        let playTitle = currentDetailTitle + ' - ' + label;
        el.addEventListener('click', () => playVideo(item.url, playTitle));
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playVideo(item.url, playTitle); }
        });
        sourceList.appendChild(el);
      }
    }
  } else {
    // TV: line list or episode list
    if (currentLineIndex === -1) {
      renderLineList(data.lines);
    } else {
      renderEpisodeList(data.lines[currentLineIndex]);
    }
  }

  searchScreen.classList.remove('active');
  sourceScreen.classList.add('active');
  focusSourceIndex = 0;
  let items = sourceList.querySelectorAll('.source-item');
  if (items.length > 0) setTimeout(() => items[0].focus(), 100);
}

function renderLineList(lines) {
  sourceCount.textContent = lines.length + ' 个线路';
  for (let i = 0; i < lines.length; i++) {
    let el = document.createElement('div');
    el.className = 'source-item';
    el.tabIndex = 0;
    el.innerHTML = `
      <span class="source-item-icon">📺</span>
      <span class="source-item-label">${escapeHtml(lines[i].name)}</span>
      <span class="source-item-index">${lines[i].items.length} 集</span>
    `;
    el.addEventListener('click', () => selectLine(i));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectLine(i); }
    });
    sourceList.appendChild(el);
  }
}

function renderEpisodeList(line) {
  sourceCount.textContent = line.items.length + ' 集';
  for (let i = 0; i < line.items.length; i++) {
    let item = line.items[i];
    let el = document.createElement('div');
    el.className = 'source-item';
    el.tabIndex = 0;
    el.innerHTML = `
      <span class="source-item-icon">🎬</span>
      <span class="source-item-label">${escapeHtml(item.label)}</span>
      <span class="source-item-index">${i + 1} / ${line.items.length}</span>
    `;
    let playTitle = currentDetailTitle + ' - ' + (currentDetailData.lines[currentLineIndex] || {}).name + ' ' + item.label;
    el.addEventListener('click', () => playVideo(item.url, playTitle));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playVideo(item.url, playTitle); }
    });
    sourceList.appendChild(el);
  }
}

function selectLine(lineIdx) {
  currentLineIndex = lineIdx;
  let line = currentDetailData && currentDetailData.lines ? currentDetailData.lines[lineIdx] : null;
  if (line) {
    console.log('[selectLine] line=' + lineIdx + ' name="' + line.name + '" items=' + (line.items ? line.items.length : 0));
  } else {
    console.warn('[selectLine] line=' + lineIdx + ' NOT FOUND in lines (count=' + (currentDetailData ? currentDetailData.lines.length : 0) + ')');
  }
  showSourceSelection();
}

function exitToLines() {
  currentLineIndex = -1;
  showSourceSelection();
}

function exitSourceScreen() {
  sourceScreen.classList.remove('active');
  searchScreen.classList.add('active');
  searchInputEl.focus();
}

// --- Player Controls ---

function formatTime(t) {
  if (isNaN(t) || !isFinite(t)) return '00:00';
  let m = Math.floor(t / 60);
  let s = Math.floor(t % 60);
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
}

function updatePlayerTime() {
  let cur = document.getElementById('ctrlCurrentTime');
  let dur = document.getElementById('ctrlDuration');
  let fill = document.getElementById('ctrlProgressFill');
  if (!cur || !dur || !fill) return;
  cur.textContent = formatTime(videoPlayer.currentTime);
  dur.textContent = formatTime(videoPlayer.duration || 0);
  let pct = videoPlayer.duration ? ((videoPlayer.currentTime / videoPlayer.duration) * 100) : 0;
  fill.style.width = Math.min(pct, 100) + '%';
}

function showPlayerControls() {
  let ctrl = document.getElementById('playerControls');
  if (!ctrl) return;
  ctrl.classList.remove('hidden');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => ctrl.classList.add('hidden'), 4000);
  updatePlayerTime();
}

function togglePlayPause() {
  let btn = document.getElementById('ctrlPlayPause');
  if (videoPlayer.paused) {
    videoPlayer.play().catch(e => console.warn('play failed', e));
    if (btn) btn.textContent = '⏸';
  } else {
    videoPlayer.pause();
    if (btn) btn.textContent = '▶';
  }
}

function seekRelative(seconds) {
  let t = Math.max(0, Math.min((videoPlayer.currentTime || 0) + seconds, videoPlayer.duration || 0));
  videoPlayer.currentTime = t;
  updatePlayerTime();
}

function playVideo(url, title) {
  playerScreen.classList.add('active');
  playerTitle.textContent = title || '';

  // Show custom controls
  let ctrl = document.getElementById('playerControls');
  if (ctrl) {
    ctrl.classList.remove('hidden');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => ctrl.classList.add('hidden'), 4000);
  }

  // Focus play/pause on DPad
  setTimeout(() => {
    let btn = document.getElementById('ctrlPlayPause');
    if (btn) btn.focus();
  }, 200);

  // Listen for time updates
  videoPlayer.removeEventListener('timeupdate', updatePlayerTime);
  videoPlayer.addEventListener('timeupdate', updatePlayerTime);
  videoPlayer.addEventListener('play', () => {
    let btn = document.getElementById('ctrlPlayPause');
    if (btn) btn.textContent = '⏸';
  });
  videoPlayer.addEventListener('pause', () => {
    let btn = document.getElementById('ctrlPlayPause');
    if (btn) btn.textContent = '▶';
  });

  // Clean up old HLS instance
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

  if (url.endsWith('.m3u8')) {
    if (Hls.isSupported()) {
      hlsInstance = new Hls();
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(videoPlayer);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
        videoPlayer.play().catch(e => console.warn('play failed', e));
      });
      hlsInstance.on(Hls.Events.ERROR, (e, data) => {
        if (data.fatal) showToast('播放出错');
      });
    } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
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

function exitPlayer() {
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  videoPlayer.pause();
  videoPlayer.src = '';
  videoPlayer.removeEventListener('timeupdate', updatePlayerTime);
  playerScreen.classList.remove('active');
  // Hide custom controls
  let ctrl = document.getElementById('playerControls');
  if (ctrl) ctrl.classList.add('hidden');
  clearTimeout(controlsTimer);
  // Go back to source selection
  sourceScreen.classList.add('active');
  let items = sourceList.querySelectorAll('.source-item');
  if (items.length > 0) setTimeout(() => items[0].focus(), 100);
}

// --- Back Button Handlers ---
backBtn.addEventListener('click', exitPlayer);
backBtn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); exitPlayer(); }
});

sourceBackBtn.addEventListener('click', () => {
  if (currentLineIndex >= 0) { exitToLines(); }
  else { exitSourceScreen(); }
});
sourceBackBtn.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (currentLineIndex >= 0) { exitToLines(); }
    else { exitSourceScreen(); }
  }
});

// --- Play/Pause button click handler ---
document.addEventListener('click', (e) => {
  let btn = e.target.closest('#ctrlPlayPause');
  if (btn) togglePlayPause();
});

// --- Android TV Back Key ---
document.addEventListener('keydown', (e) => {
  if (e.key === 'Back' || e.key === 'Escape') {
    if (playerScreen.classList.contains('active')) {
      e.preventDefault();
      exitPlayer();
    } else if (sourceScreen.classList.contains('active')) {
      e.preventDefault();
      if (currentLineIndex >= 0) { exitToLines(); }
      else { exitSourceScreen(); }
    } else if (bridgeAvailable()) {
      Android.exitApp();
    }
  }
});

// --- DPad Navigation for Player Screen ---
document.addEventListener('keydown', (e) => {
  if (!playerScreen.classList.contains('active')) return;

  showPlayerControls();

  switch (e.key) {
    case 'Enter':
    case 'MediaPlayPause':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      seekRelative(-10);
      break;
    case 'ArrowRight':
      e.preventDefault();
      seekRelative(10);
      break;
    case 'ArrowUp':
    case 'ArrowDown':
      e.preventDefault();
      document.getElementById('ctrlPlayPause').focus();
      break;
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

// --- DPad Navigation for Source List ---
document.addEventListener('keydown', (e) => {
  if (!sourceScreen.classList.contains('active')) return;

  let items = sourceList.querySelectorAll('.source-item');
  if (items.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    focusSourceIndex = Math.min(focusSourceIndex + 1, items.length - 1);
    items[focusSourceIndex].focus();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    focusSourceIndex = Math.max(focusSourceIndex - 1, 0);
    items[focusSourceIndex].focus();
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
