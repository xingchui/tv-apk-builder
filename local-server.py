"""
Local development server for ikanbot TV app.
Serves static files + provides search/play API endpoints.
No external dependencies needed (uses Python stdlib).

Usage: python local-server.py
Then open http://localhost:8080
"""

import http.server
import json
import re
import urllib.parse
import urllib.request
from pathlib import Path

BASE_URL = 'https://www.ikanbot.com'
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
STATIC_DIR = Path(__file__).parent / 'app' / 'src' / 'main' / 'assets'


# ---- Helpers ----

def compute_token(current_id, e_token):
    """Same algorithm as WebAppInterface.computeToken()."""
    suffix = current_id[-4:]
    result = ''
    remaining = e_token
    for ch in suffix:
        digit = int(ch)
        offset = (digit % 3) + 1
        if offset + 8 > len(remaining):
            break
        result += remaining[offset:offset + 8]
        remaining = remaining[offset + 8:]
    return result


def normalize_thumbnail(url):
    if not url:
        return ''
    if url.startswith('http'):
        return url
    if url.startswith('//'):
        return 'https:' + url
    if url.startswith('data:'):
        return ''
    return 'https:' + url


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=15) as resp:
        return resp.read().decode('utf-8', errors='replace')


# ---- Search ----
# Regex-based extraction — ikanbot.com search HTML is consistent enough.

def search(query):
    html = fetch(f'{BASE_URL}/search?q={urllib.parse.quote(query)}')

    # Split by <div class="media"> blocks and parse each
    results = []
    # Match each result block using the outer divider
    media_blocks = re.split(r'<div\s+class="media">', html)

    for block in media_blocks[1:]:  # skip everything before first media
        if len(results) >= 20:
            break

        # cover-link href (order-independent: class= may come before or after href=)
        m = (re.search(r'<a[^>]*href="([^"]*)"[^>]*class="[^"]*cover-link[^"]*"', block)
             or re.search(r'<a[^>]*class="[^"]*cover-link[^"]*"[^>]*href="([^"]*)"', block))
        if not m:
            continue
        href = m.group(1)
        if not href:
            continue

        # title-text (order-independent)
        m = (re.search(r'<a[^>]*class="[^"]*title-text[^"]*"[^>]*>([^<]*)</a>', block)
             or re.search(r'<a[^>]*href="[^"]*"[^>]*class="[^"]*title-text[^"]*"[^>]*>([^<]*)</a>', block))
        if not m:
            continue
        title = m.group(1).strip()
        if not title:
            continue
        if len(title) > 100:
            title = title[:100]

        # thumbnail (data-src first, then src — order-independent on class)
        m = (re.search(r'<img[^>]*data-src="([^"]*)"[^>]*class="[^"]*media-pic[^"]*lazy[^"]*"', block)
             or re.search(r'<img[^>]*class="[^"]*media-pic[^"]*lazy[^"]*"[^>]*data-src="([^"]*)"', block))
        thumbnail = m.group(1) if m else ''
        if not thumbnail:
            m = (re.search(r'<img[^>]*src="([^"]*)"[^>]*class="[^"]*media-pic[^"]*lazy[^"]*"', block)
                 or re.search(r'<img[^>]*class="[^"]*media-pic[^"]*lazy[^"]*"[^>]*src="([^"]*)"', block))
            thumbnail = m.group(1) if m else ''
        thumbnail = normalize_thumbnail(thumbnail)

        # episodes label (order-independent on class)
        m = (re.search(r'<span[^>]*class="[^"]*label[^"]*"[^>]*>([^<]*)</span>', block)
             or re.search(r'<span[^>]*class="label"[^>]*>([^<]*)</span>', block))
        episodes = m.group(1).strip() if m else ''

        full_url = href if href.startswith('http') else BASE_URL + href
        results.append({
            'title': title,
            'url': full_url,
            'thumbnail': thumbnail,
            'episodes': episodes,
        })

    return {'results': results}


def get_play_info(page_url):
    """Get video play info from a play page URL."""
    html = fetch(page_url)

    current_id = ''
    mtype = ''
    e_token = ''

    m = re.search(r'<input[^>]*id="current_id"[^>]*value="([^"]*)"', html)
    if m:
        current_id = m.group(1)
    m = re.search(r'<input[^>]*id="mtype"[^>]*value="([^"]*)"', html)
    if m:
        mtype = m.group(1)
    m = re.search(r'<input[^>]*id="e_token"[^>]*value="([^"]*)"', html)
    if m:
        e_token = m.group(1)

    media_type = 'tv' if mtype == '2' else 'movie'

    if not current_id or not e_token:
        return {'type': media_type, 'lines': []}

    token = compute_token(current_id, e_token)
    api_text = fetch(f'{BASE_URL}/api/getResN?videoId={current_id}&mtype={mtype or "1"}&token={token}')

    api_json = json.loads(api_text)
    if api_json.get('state') != 1:
        return {'type': media_type, 'lines': []}

    lines = []

    data_obj = api_json.get('data')
    if data_obj and isinstance(data_obj.get('list'), list):
        for line_idx, line_item in enumerate(data_obj['list']):
            res_data_str = line_item.get('resData', '') or ''
            if not res_data_str:
                continue
            items = []
            try:
                res_array = json.loads(res_data_str)
                for res_obj in res_array:
                    url_data = res_obj.get('url', '') or ''
                    if not url_data:
                        continue
                    for entry in url_data.split('#'):
                        parts = entry.split('$', 1)
                        if len(parts) >= 2:
                            label = parts[0].strip()
                            video_url = parts[1].strip()
                            if '.m3u8' in video_url.lower() or '.mp4' in video_url.lower():
                                items.append({'url': video_url, 'label': label})
            except json.JSONDecodeError:
                for m3u8_match in re.finditer(r'https?://[^"\'\\s,]+?\.m3u8[^"\'\\s,]*', res_data_str):
                    m3u8_url = m3u8_match.group(0)
                    if not any(v['url'] == m3u8_url for v in items):
                        items.append({'url': m3u8_url, 'label': f'视频源 {len(items) + 1}'})

            if items:
                lines.append({
                    'name': f'线路{line_idx + 1}',
                    'items': items,
                })
                print(f'[get_play_info] Line {line_idx + 1}: {len(items)} items', flush=True)

    total_all = sum(len(l['items']) for l in lines)
    print(f'[get_play_info] Total: {total_all} items across {len(lines)} lines (type={media_type})', flush=True)
    return {'type': media_type, 'lines': lines}


class CombinedHandler(http.server.SimpleHTTPRequestHandler):
    """Serves static files + API endpoints."""

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if parsed.path == '/api/search':
            q = params.get('q', [''])[0]
            if not q:
                self.send_json(400, {'error': 'Missing ?q='})
                return
            try:
                data = search(q)
                self.send_json(200, data)
            except Exception as e:
                self.send_json(500, {'error': str(e)})
            return

        if parsed.path == '/api/play':
            play_url = params.get('url', [''])[0]
            if not play_url:
                self.send_json(400, {'error': 'Missing ?url='})
                return
            try:
                data = get_play_info(play_url)
                self.send_json(200, data)
            except Exception as e:
                self.send_json(500, {'error': str(e)})
            return

        # Default: serve static files
        super().do_GET()

    def send_json(self, status, data):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def log_message(self, format, *args):
        print(f'[local-server] {args[0]} {args[1]} {args[2]}')


if __name__ == '__main__':
    import os
    os.chdir(str(STATIC_DIR))
    server = http.server.HTTPServer(('0.0.0.0', 8080), CombinedHandler)
    print(f'[local-server] http://localhost:8080')
    print(f'[local-server]   /api/search?q=四渡赤水')
    print(f'[local-server]   /api/play?url=...')
    print(f'[local-server]   (also serves static files from {STATIC_DIR})')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        server.shutdown()
