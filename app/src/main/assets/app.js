/* ============================================================
   app.js — TV Search & Playback
   ============================================================ */

// --- State ---
let currentResults = [];
let currentDetailData = null;        // {type:"movie"|"tv", lines:[{name, items:[{label,url}]}]}
let currentDetailTitle = '';
let currentLineIndex = -1;           // -1 = line list, >=0 = episode list for that line
let currentPlayLineIndex = -1;       // current playing line index (for next-ep)
let currentPlayEpisodeIndex = -1;    // current playing episode index (for next-ep)

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

// --- Volume State (persisted across sessions) ---
const VOLUME_KEY = 'tvsearch_volume';
let volumeLevel = 1;

// --- Watch History (continue watching) ---
const HISTORY_KEY = 'tvsearch_watch_history';
const HISTORY_MAX = 12;

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

function nativePlayVideo(url, title, resumeTime) {
  if (bridgeAvailable()) {
    Android.playVideoNative(JSON.stringify({
      url: url,
      title: title || '',
      resumeTime: (resumeTime && resumeTime > 0) ? resumeTime : 0,
      volume: volumeLevel
    }));
    return true;
  }
  return false;
}

// --- Local Proxy ---
// When native bridge is unavailable (browser testing), runs queries through
// the local Python server: python local-server.py

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

const BASE_URL = 'https://www.ikanbot.com';

function computeToken(currentId, eToken) {
  // Token algorithm: suffix[-4:], each char digit%3+1 offset, take 8 chars, repeat
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
  return await localProxySearch(query);
}

async function browserGetPlayInfo(pageUrl) {
  return await localProxyGetPlayInfo(pageUrl);
}

// --- Toast ---
let toastTimer = null;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
}

// --- Volume Control ---
function updateVolumeBtn() {
  let btn = document.getElementById('ctrlVolume');
  if (!btn) return;
  btn.textContent = (videoPlayer.muted || volumeLevel === 0) ? '🔇' : '🔊';
}

function applyVolume(v) {
  volumeLevel = Math.max(0, Math.min(1, v));
  videoPlayer.volume = volumeLevel;
  if (volumeLevel > 0 && videoPlayer.muted) videoPlayer.muted = false;
  updateVolumeBtn();
  try { localStorage.setItem(VOLUME_KEY, String(volumeLevel)); } catch (e) {}
}

function setVolume(v) {
  applyVolume(v);
  showToast(videoPlayer.muted ? '已静音' : '音量 ' + Math.round(volumeLevel * 100) + '%');
}

function toggleMute() {
  videoPlayer.muted = !videoPlayer.muted;
  updateVolumeBtn();
  showToast(videoPlayer.muted ? '已静音' : '音量 ' + Math.round(volumeLevel * 100) + '%');
}

function initVolume() {
  try {
    let saved = parseFloat(localStorage.getItem(VOLUME_KEY));
    if (isFinite(saved) && saved >= 0 && saved <= 1) volumeLevel = saved;
  } catch (e) {}
  videoPlayer.volume = volumeLevel;
  videoPlayer.muted = false;
  updateVolumeBtn();
}

// --- Search ---
let searchInProgress = false;

async function performSearch() {
  if (searchInProgress) return;
  let query = searchInputEl.value.trim();
  if (!query) { showToast('请输入搜索关键词'); return; }

  searchInProgress = true;
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
        return;
      }
    } else {
      data = await browserSearch(query);
    }

    if (data.error) {
      showToast('搜索失败: ' + data.error);
      return;
    }
    if (!data || !data.results || data.results.length === 0) {
      emptyState.classList.remove('hidden');
      document.getElementById('emptyHint').textContent = '未找到结果';
      return;
    }

    currentResults = data.results;
    renderResults(currentResults);
  } catch (e) {
    showToast('搜索失败: ' + e.message);
  } finally {
    loadingIndicator.classList.add('hidden');
    searchInProgress = false;
  }
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
        e.stopPropagation();
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
          <span class="source-item-index">${line.items.length} 源</span>
        `;
        let playTitle = currentDetailTitle + ' - ' + label;
        el.addEventListener('click', () => {
          currentPlayLineIndex = li; currentPlayEpisodeIndex = ii;
          playVideo(item.url, playTitle);
        });
        el.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); currentPlayLineIndex = li; currentPlayEpisodeIndex = ii; playVideo(item.url, playTitle); }
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
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); selectLine(i); }
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
    let playTitle = currentDetailTitle + ' - ' + (line ? line.name : '未知线路') + ' ' + item.label;
    el.addEventListener('click', () => {
      currentPlayLineIndex = currentLineIndex; currentPlayEpisodeIndex = i;
      playVideo(item.url, playTitle);
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); currentPlayLineIndex = currentLineIndex; currentPlayEpisodeIndex = i; playVideo(item.url, playTitle); }
    });
    sourceList.appendChild(el);
  }
}

function selectLine(lineIdx) {
  if (!currentDetailData || !currentDetailData.lines || lineIdx < 0 || lineIdx >= currentDetailData.lines.length) {
    console.warn('[selectLine] Invalid line index:', lineIdx, '(total lines:', (currentDetailData ? currentDetailData.lines.length : 0) + ')');
    return;
  }
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

let updateTimeRaf = null;

function updatePlayerTime() {
  if (updateTimeRaf) return;
  updateTimeRaf = requestAnimationFrame(() => {
    updateTimeRaf = null;
    let cur = document.getElementById('ctrlCurrentTime');
    let dur = document.getElementById('ctrlDuration');
    let fill = document.getElementById('ctrlProgressFill');
    if (!cur || !dur || !fill) return;
    cur.textContent = formatTime(videoPlayer.currentTime);
    dur.textContent = formatTime(videoPlayer.duration || 0);
    let pct = videoPlayer.duration ? ((videoPlayer.currentTime / videoPlayer.duration) * 100) : 0;
    fill.style.width = Math.min(pct, 100) + '%';
  });
}

function showPlayerControls() {
  let ctrl = document.getElementById('playerControls');
  if (!ctrl) return;
  ctrl.classList.remove('hidden');
  clearTimeout(controlsTimer);
  controlsTimer = setTimeout(() => ctrl.classList.add('hidden'), 4000);
  updatePlayerTime();
}

function syncPlayBtn() {
  let btn = document.getElementById('ctrlPlayPause');
  if (!btn) return;
  btn.textContent = videoPlayer.paused ? '▶' : '⏸';
}

function togglePlayPause() {
  let btn = document.getElementById('ctrlPlayPause');
  if (videoPlayer.paused) {
    videoPlayer.play().then(() => { if (btn) btn.textContent = '⏸'; })
      .catch(e => {
        console.warn('play failed', e);
        if (btn) btn.textContent = '▶';
        showToast('播放失败: ' + e.message);
      });
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

// --- Desktop playback speed ---
const SPEED_OPTIONS = [0.5, 1, 1.5, 2];
let speedIndex = 1; // index into SPEED_OPTIONS (default 1x)

function updateSpeedBtn() {
  let btn = document.getElementById('ctrlSpeed');
  if (btn) btn.textContent = SPEED_OPTIONS[speedIndex] + 'x';
}

function cycleSpeed() {
  speedIndex = (speedIndex + 1) % SPEED_OPTIONS.length;
  videoPlayer.playbackRate = SPEED_OPTIONS[speedIndex];
  updateSpeedBtn();
  showToast('倍速 ' + SPEED_OPTIONS[speedIndex] + 'x');
}

// --- Watch History (continue watching) ---
function loadHistory() {
  try {
    let raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    let arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function saveHistoryEntry(url, title, currentTime, duration) {
  if (!url || !currentTime || currentTime < 5) return;
  if (duration && currentTime > duration - 5) return; // watched to end → nothing to resume
  let history = loadHistory().filter(h => h.url !== url);
  history.unshift({ url: url, title: title || '', currentTime: currentTime, duration: duration || 0, updatedAt: Date.now() });
  if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) {}
  renderHistory();
}

function removeHistoryEntry(url) {
  let history = loadHistory().filter(h => h.url !== url);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) {}
  renderHistory();
}

function formatWatchTime(sec) {
  sec = Math.floor(sec || 0);
  let h = Math.floor(sec / 3600);
  let m = Math.floor((sec % 3600) / 60);
  let s = sec % 60;
  let mm = String(m).padStart(2, '0');
  let ss = String(s).padStart(2, '0');
  return h > 0 ? h + ':' + mm + ':' + ss : mm + ':' + ss;
}

function renderHistory() {
  let section = document.getElementById('historySection');
  if (!section) return;
  let history = loadHistory();
  if (history.length === 0) {
    section.classList.add('hidden');
    section.innerHTML = '';
    return;
  }
  section.classList.remove('hidden');
  let cards = history.map(h => {
    let pct = (h.duration && h.currentTime) ? Math.min(100, Math.round((h.currentTime / h.duration) * 100)) : 0;
    let timeStr = formatWatchTime(h.currentTime) + (h.duration ? ' / ' + formatWatchTime(h.duration) : '');
    return '<div class="history-card" tabindex="0" data-url="' + h.url + '">'
      + '<button class="history-card-remove" data-url="' + h.url + '" title="从历史移除">✕</button>'
      + '<div class="history-card-title">' + escapeHtml(h.title || '') + '</div>'
      + '<div class="history-card-progress"><div class="history-card-progress-fill" style="width:' + pct + '%"></div></div>'
      + '<div class="history-card-time">' + timeStr + '</div>'
      + '</div>';
  }).join('');
  section.innerHTML = '<h2 class="history-title">继续观看</h2><div class="history-cards">' + cards + '</div>';

  section.querySelectorAll('.history-card').forEach(card => {
    card.addEventListener('click', () => {
      let entry = loadHistory().find(x => x.url === card.dataset.url);
      if (entry) resumeFromHistory(entry);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        let entry = loadHistory().find(x => x.url === card.dataset.url);
        if (entry) resumeFromHistory(entry);
      }
    });
  });
  section.querySelectorAll('.history-card-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeHistoryEntry(btn.dataset.url);
    });
  });
}

function resumeFromHistory(entry) {
  playVideo(entry.url, entry.title, entry.currentTime || 0);
}

function saveCurrentProgress() {
  let t = videoPlayer.currentTime || 0;
  let d = videoPlayer.duration || 0;
  if (t > 5 && (!d || t < d - 5)) {
    saveHistoryEntry(videoPlayer.currentSrc || videoPlayer.src, playerTitle.textContent, t, d);
  }
}

// --- Progress bar: click / drag to seek (desktop mouse) ---
function seekToRatio(ratio) {
  let dur = videoPlayer.duration || 0;
  if (!dur) return;
  let t = Math.max(0, Math.min(ratio, 1)) * dur;
  videoPlayer.currentTime = t;
  updatePlayerTime();
}

function setupProgressSeek() {
  let bar = document.getElementById('ctrlProgress');
  if (!bar) return;
  let dragging = false;
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    bar.classList.add('dragging');
    bar.setPointerCapture(e.pointerId);
    let rect = bar.getBoundingClientRect();
    seekToRatio((e.clientX - rect.left) / rect.width);
    showPlayerControls();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    let rect = bar.getBoundingClientRect();
    seekToRatio((e.clientX - rect.left) / rect.width);
  });
  let endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('dragging');
    if (bar.hasPointerCapture(e.pointerId)) bar.releasePointerCapture(e.pointerId);
  };
  bar.addEventListener('pointerup', endDrag);
  bar.addEventListener('pointercancel', endDrag);
}

// --- Native fullscreen (pywebview desktop) vs HTML5 fallback ---
function nativeFullscreenAvailable() {
  return typeof window.pywebview !== 'undefined'
      && window.pywebview.api
      && typeof window.pywebview.api.toggle_fullscreen === 'function';
}

function refreshNativeFullscreenIcon() {
  if (!nativeFullscreenAvailable()) return;
  Promise.resolve(window.pywebview.api.is_fullscreen()).then(fs => {
    let btn = document.getElementById('ctrlFullscreen');
    if (btn) btn.textContent = fs ? '⛶' : '⛶';
  }).catch(() => {});
}

function toggleFullscreen() {
  if (nativeFullscreenAvailable()) {
    window.pywebview.api.toggle_fullscreen();
    refreshNativeFullscreenIcon();
    showPlayerControls();
    return;
  }
  let container = document.getElementById('videoContainer');
  if (!container) return;
  if (!document.fullscreenElement) {
    container.requestFullscreen().catch(e => console.warn('fullscreen failed', e));
  } else {
    document.exitFullscreen();
  }
}

function updateNextEpVisibility() {
  let btn = document.getElementById('ctrlNextEp');
  if (!btn) return;
  btn.classList.toggle('hidden-nav', !hasNextEpisode());
}

function playNextEpisode() {
  if (!currentDetailData || currentDetailData.type !== 'tv') return;
  if (currentPlayLineIndex < 0 || currentPlayEpisodeIndex < 0) return;
  let line = currentDetailData.lines[currentPlayLineIndex];
  if (!line || currentPlayEpisodeIndex + 1 >= line.items.length) {
    showToast('已是最后一集');
    return;
  }
  currentPlayEpisodeIndex++;
  let item = line.items[currentPlayEpisodeIndex];
  let playTitle = currentDetailTitle + ' - ' + line.name + ' ' + item.label;
  playVideo(item.url, playTitle);
}

// --- Auto-play next episode when current one ends ---
function hasNextEpisode() {
  return currentDetailData && currentDetailData.type === 'tv'
      && currentPlayLineIndex >= 0 && currentPlayEpisodeIndex >= 0
      && currentDetailData.lines[currentPlayLineIndex]
      && currentPlayEpisodeIndex + 1 < currentDetailData.lines[currentPlayLineIndex].items.length;
}

function onVideoEnded() {
  if (hasNextEpisode()) {
    showToast('自动播放下一集');
    playNextEpisode();
  } else {
    showToast('播放结束');
  }
}

// --- Native playback bridge callbacks ---
// Invoked from MainActivity via evaluateJavascript after ExoPlayerActivity finishes.
// These make watch-history / resume / auto-next work on the Android TV native path,
// not just the browser HLS.js fallback.

// ExoPlayer finished a video: auto-play the next episode if the finished URL
// matches the episode we believe is playing, otherwise just notify.
window.onNativePlaybackEnded = function(url) {
  let playing = currentDetailData && currentDetailData.type === 'tv'
      && currentPlayLineIndex >= 0 && currentPlayEpisodeIndex >= 0
      && currentDetailData.lines[currentPlayLineIndex];
  if (playing) {
    let item = currentDetailData.lines[currentPlayLineIndex].items[currentPlayEpisodeIndex];
    if (item && item.url === url) {
      onVideoEnded();
      return;
    }
  }
  showToast('播放结束');
};

// ExoPlayer saved progress: merge into the JS watch-history store so resume
// works on TV. info = {url, title, positionMs, durationMs}.
window.onNativeProgressSaved = function(info) {
  if (!info || !info.url) return;
  saveHistoryEntry(info.url, info.title || '', (info.positionMs || 0) / 1000, (info.durationMs || 0) / 1000);
};

// --- Named listener functions (so they can be removed) ---
function onVideoPlay() { syncPlayBtn(); }
function onVideoPause() { syncPlayBtn(); }

function clearPlayerListeners() {
  videoPlayer.removeEventListener('timeupdate', updatePlayerTime);
  videoPlayer.removeEventListener('play', onVideoPlay);
  videoPlayer.removeEventListener('pause', onVideoPause);
  videoPlayer.removeEventListener('ended', onVideoEnded);
  videoPlayer.onerror = null;
}

function playVideo(url, title, resumeTime) {
  // Use native ExoPlayer when available (Android TV production path)
  // This bypasses all WebView <video> + HLS.js issues (play/pause race, MediaSource, etc.)
  if (nativePlayVideo(url, title, resumeTime)) {
    return;
  }

  // Fallback: WebView <video> + HLS.js for browser development testing
  playerScreen.classList.add('active');
  playerTitle.textContent = title || '';

  // Reset current time for fresh playback (resumeTime applied in doPlay)
  videoPlayer.currentTime = 0;

  // Reset playback speed to 1x for a fresh video
  speedIndex = 1;
  videoPlayer.playbackRate = 1;
  updateSpeedBtn();

  // Clean up previous listeners
  clearPlayerListeners();

  // Attach fresh listeners
  videoPlayer.addEventListener('timeupdate', updatePlayerTime);
  videoPlayer.addEventListener('play', onVideoPlay);
  videoPlayer.addEventListener('pause', onVideoPause);
  videoPlayer.addEventListener('ended', onVideoEnded);

  // Assert paused icon (will be updated by play event)
  syncPlayBtn();

  // Show custom controls
  let ctrl = document.getElementById('playerControls');
  if (ctrl) {
    ctrl.classList.remove('hidden');
    clearTimeout(controlsTimer);
    controlsTimer = setTimeout(() => ctrl.classList.add('hidden'), 4000);
  }

  // Focus play/pause on DPad (deferred so the element is layout-ready)
  setTimeout(() => {
    let btn = document.getElementById('ctrlPlayPause');
    if (btn) btn.focus();
  }, 200);

  // Clean up old HLS instance
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

  function doPlay() {
    if (resumeTime > 0) {
      try { videoPlayer.currentTime = resumeTime; } catch (e) {}
    }
    videoPlayer.play().then(syncPlayBtn).catch(e => {
      console.warn('playVideo play() failed', e);
      syncPlayBtn();
      showToast('播放失败: ' + e.message);
    });
  }

  if (url.endsWith('.m3u8')) {
    if (Hls.isSupported()) {
      hlsInstance = new Hls({
        xhrSetup: function(xhr, url) {
          xhr.setRequestHeader('Referer', 'https://www.ikanbot.com/');
          xhr.setRequestHeader('Origin', 'https://www.ikanbot.com');
        }
      });
      hlsInstance.loadSource(url);
      hlsInstance.attachMedia(videoPlayer);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED, doPlay);
      hlsInstance.on(Hls.Events.ERROR, (e, data) => {
        if (data.fatal) {
          showToast('播放出错: ' + (data.response ? data.response.code : '加载失败'));
        } else if (data.details === 'bufferStallError' || data.details === 'bufferNudgeOnStall') {
          // Recoverable stall — try to resume
          videoPlayer.play().catch(function(){});
        }
      });
    } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      videoPlayer.src = url;
      doPlay();
    } else {
      showToast('当前设备不支持 HLS 播放');
    }
  } else if (url.endsWith('.mp4')) {
    // Add listener BEFORE setting src to avoid race
    videoPlayer.addEventListener('canplay', doPlay, { once: true });
    videoPlayer.src = url;
    // Fallback: if canplay never fires, try after a timeout
    setTimeout(() => {
      if (videoPlayer.paused && videoPlayer.readyState < 3) doPlay();
    }, 3000);
  } else {
    // Unknown format — try native anyway
    videoPlayer.src = url;
    doPlay();
  }

  // Catch native video errors
  videoPlayer.onerror = function() {
    let msg = '视频加载错误';
    if (videoPlayer.error) {
      switch (videoPlayer.error.code) {
        case MediaError.MEDIA_ERR_ABORTED: msg = '播放被中断'; break;
        case MediaError.MEDIA_ERR_NETWORK: msg = '网络加载失败'; break;
        case MediaError.MEDIA_ERR_DECODE: msg = '视频解码失败'; break;
        case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: msg = '不支持的视频格式'; break;
      }
    }
    showToast(msg);
    syncPlayBtn();
  };

  updateNextEpVisibility();
}

function exitPlayer() {
  saveCurrentProgress();
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  videoPlayer.pause();
  videoPlayer.src = '';
  clearPlayerListeners();
  videoPlayer.currentTime = 0;
  if (updateTimeRaf) { cancelAnimationFrame(updateTimeRaf); updateTimeRaf = null; }
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

// --- Player button click handlers ---
document.addEventListener('click', (e) => {
  let btn = e.target.closest('#ctrlPlayPause');
  if (btn) { e.stopPropagation(); togglePlayPause(); return; }
  btn = e.target.closest('#ctrlNextEp');
  if (btn) { e.stopPropagation(); playNextEpisode(); return; }
  btn = e.target.closest('#ctrlSpeed');
  if (btn) { e.stopPropagation(); cycleSpeed(); return; }
  btn = e.target.closest('#ctrlVolume');
  if (btn) { e.stopPropagation(); toggleMute(); return; }
  btn = e.target.closest('#ctrlFullscreen');
  if (btn) { e.stopPropagation(); toggleFullscreen(); return; }
  // Progress bar: don't let bar clicks bubble into click-to-toggle
  if (e.target.closest('#ctrlProgress')) return;
  // Click anywhere on the video area (not a button / bar): toggle play/pause
  if (e.target.closest('#videoContainer')) {
    showPlayerControls();
    togglePlayPause();
  }
});

// --- Desktop: move the mouse anywhere in the player → show controls ---
document.addEventListener('mousemove', (e) => {
  if (!playerScreen.classList.contains('active')) return;
  showPlayerControls();
});

// --- Desktop: mouse wheel over the player → adjust volume ---
let volumeWheelLock = 0;
document.addEventListener('wheel', (e) => {
  if (!playerScreen.classList.contains('active')) return;
  if (e.target.closest('.ctrl-progress')) return;
  e.preventDefault();
  let now = Date.now();
  if (now - volumeWheelLock < 80) return;
  volumeWheelLock = now;
  setVolume(volumeLevel + (e.deltaY > 0 ? -0.05 : 0.05));
}, { passive: false });

// --- Android TV Back Key ---
document.addEventListener('keydown', (e) => {
  if (e.key === 'Back' || e.key === 'Escape') {
    // Native (pywebview) fullscreen: Esc exits the OS-level fullscreen window
    if (nativeFullscreenAvailable() && !document.fullscreenElement) {
      Promise.resolve(window.pywebview.api.is_fullscreen()).then(fs => {
        if (fs) {
          window.pywebview.api.exit_fullscreen();
          refreshNativeFullscreenIcon();
          showPlayerControls();
        } else {
          fallbackBackKey(e);
        }
      }).catch(() => fallbackBackKey(e));
      return;
    }
    if (document.fullscreenElement) {
      e.preventDefault();
      document.exitFullscreen();
      return;
    }
    fallbackBackKey(e);
  }
});

function fallbackBackKey(e) {
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

// --- DPad Navigation for Player Screen ---
document.addEventListener('keydown', (e) => {
  if (!playerScreen.classList.contains('active')) return;

  // Space bar = play/pause (desktop); MediaPlayPause = TV remote
  if (e.key === ' ') {
    e.preventDefault();
    togglePlayPause();
    return;
  }

  // M key = mute/unmute (desktop)
  if (e.key === 'm' || e.key === 'M') {
    e.preventDefault();
    toggleMute();
    return;
  }

  showPlayerControls();

  let ctrlBtns = ['backBtn', 'ctrlNextEp', 'ctrlPlayPause', 'ctrlVolume', 'ctrlSpeed', 'ctrlFullscreen'];
  let active = document.activeElement;
  let activeId = active ? active.id : '';
  let activeIdx = ctrlBtns.indexOf(activeId);

  switch (e.key) {
    case 'Enter':
      e.preventDefault();
      if (activeId === 'backBtn') { exitPlayer(); }
      else if (activeId === 'ctrlNextEp') { playNextEpisode(); }
      else if (activeId === 'ctrlVolume') { toggleMute(); }
      else if (activeId === 'ctrlSpeed') { cycleSpeed(); }
      else if (activeId === 'ctrlFullscreen') { toggleFullscreen(); }
      else if (e.target.closest('#playerControls') || e.target.closest('.player-bar')) {
        togglePlayPause();
      }
      // else: Enter from outside player (bubbled) — ignore
      break;
    case 'MediaPlayPause':
      e.preventDefault();
      togglePlayPause();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (activeIdx >= 0) {
        let prevIdx = activeIdx - 1;
        // Skip ctrlNextEp if hidden
        while (prevIdx >= 0) {
          let btn = document.getElementById(ctrlBtns[prevIdx]);
          if (btn && !btn.classList.contains('hidden-nav')) break;
          prevIdx--;
        }
        if (prevIdx >= 0) {
          document.getElementById(ctrlBtns[prevIdx]).focus();
        } else {
          // wrap to last
          let lastIdx = ctrlBtns.length - 1;
          while (lastIdx > activeIdx) {
            let btn = document.getElementById(ctrlBtns[lastIdx]);
            if (btn && !btn.classList.contains('hidden-nav')) break;
            lastIdx--;
          }
          document.getElementById(ctrlBtns[lastIdx]).focus();
        }
      } else {
        seekRelative(-10);
      }
      break;
    case 'ArrowRight':
      e.preventDefault();
      if (activeIdx >= 0) {
        let nextIdx = activeIdx + 1;
        while (nextIdx < ctrlBtns.length) {
          let btn = document.getElementById(ctrlBtns[nextIdx]);
          if (btn && !btn.classList.contains('hidden-nav')) break;
          nextIdx++;
        }
        if (nextIdx < ctrlBtns.length) {
          document.getElementById(ctrlBtns[nextIdx]).focus();
        } else {
          // wrap to first
          let firstIdx = 0;
          while (firstIdx < activeIdx) {
            let btn = document.getElementById(ctrlBtns[firstIdx]);
            if (btn && !btn.classList.contains('hidden-nav')) break;
            firstIdx++;
          }
          document.getElementById(ctrlBtns[firstIdx]).focus();
        }
      } else {
        seekRelative(10);
      }
      break;
    case 'ArrowUp':
    case 'ArrowDown':
      e.preventDefault();
      if (activeId === 'backBtn') {
        // move from backBtn to bottom row
        document.getElementById('ctrlPlayPause').focus();
      } else if (activeIdx > 0) {
        document.getElementById('ctrlPlayPause').focus();
      } else {
        document.getElementById('backBtn').focus();
      }
      break;
  }
});

// --- Fullscreen change listener (update button icon) ---
document.addEventListener('fullscreenchange', () => {
  let btn = document.getElementById('ctrlFullscreen');
  if (btn) btn.textContent = document.fullscreenElement ? '⛶' : '⛶';
  // Keep controls visible briefly after fullscreen toggle
  showPlayerControls();
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
  let active = document.activeElement;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (active === sourceBackBtn) {
      // Move from back button to first item
      focusSourceIndex = 0;
      if (items.length > 0) items[0].focus();
    } else {
      focusSourceIndex = Math.min(focusSourceIndex + 1, items.length - 1);
      items[focusSourceIndex].focus();
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (focusSourceIndex <= 0) {
      // Move up to back button
      sourceBackBtn.focus();
    } else {
      focusSourceIndex = Math.max(focusSourceIndex - 1, 0);
      items[focusSourceIndex].focus();
    }
  } else if (e.key === 'ArrowLeft' && document.activeElement !== sourceBackBtn) {
    // Left goes to the back button
    e.preventDefault();
    sourceBackBtn.focus();
  } else if (e.key === 'ArrowRight' && active === sourceBackBtn) {
    // Right goes from back button to first item
    e.preventDefault();
    focusSourceIndex = 0;
    if (items.length > 0) items[0].focus();
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
  setupProgressSeek();
  initVolume();
  renderHistory();
});
