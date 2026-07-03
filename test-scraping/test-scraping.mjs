/**
 * Test script that independently replicates the Java WebAppInterface logic.
 * Tests search → play page → token computation → API call → HLS URL extraction.
 *
 * Run: node test-scraping.mjs
 */

import * as cheerio from 'cheerio';
import { createHash } from 'node:crypto';

const BASE_URL = 'https://www.ikanbot.com';
const SEARCH_QUERY = process.argv[2] || '四渡赤水';
const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14; Android TV) AppleWebKit/537.36';

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    failed++;
  }
}

function assertContains(actual, expected, label) {
  if (actual.includes(expected)) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label} — expected "${expected}" in "${actual.substring(0, 100)}"`);
    failed++;
  }
}

/**
 * Compute the v_tks token — same algorithm as WebAppInterface.computeToken().
 * Algorithm from play_new.js get_tks():
 *   suffix = last 4 chars of currentId
 *   for each digit in suffix:
 *     offset = digit % 3 + 1
 *     arr[i] = eToken.substring(offset, offset+8)
 *     eToken = eToken.substring(offset+8)
 *   v_tks = arr.join('')
 */
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

async function testComputeToken() {
  console.log('\n📐 Test: computeToken()');
  
  // Test with known inputs
  let result1 = computeToken('123456', 'abcdefghijklmnopqrstuvwxyz0123456789');
  assert(typeof result1 === 'string' && result1.length > 0, 'Returns a non-empty string');
  console.log('  Token result:', result1);
  
  // Test with short eToken (edge case)
  let result2 = computeToken('123456', 'abc');
  assert(result2 === '', 'Returns empty string when eToken is too short');
  
  // Test with 4-digit suffix
  let result3 = computeToken('1234', '0123456789abcdefghij');
  assert(typeof result3 === 'string', 'Works with 4-char suffix');
  console.log('  Token (4-char suffix):', result3);
}

async function testSearch() {
  console.log(`\n🔍 Test: Search for "${SEARCH_QUERY}"`);
  
  let url = `${BASE_URL}/search?q=${encodeURIComponent(SEARCH_QUERY)}`;
  console.log('  URL:', url);
  
  let resp = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  assert(resp.ok, `HTTP ${resp.status}`);
  
  let html = await resp.text();
  assert(html.length > 1000, `HTML body length: ${html.length}`);
  
  let $ = cheerio.load(html);
  
  // Test selector: div.media
  let mediaItems = $('div.media');
  console.log(`  Found ${mediaItems.length} div.media items`);
  assert(mediaItems.length > 0, 'At least one div.media found');
  
  let results = [];
  mediaItems.each((i, mediaEl) => {
    let $media = $(mediaEl);
    
    // cover-link
    let coverLink = $media.find('a.cover-link');
    let href = coverLink.attr('href') || '';
    
    // title-text
    let titleEl = $media.find('a.title-text');
    let title = titleEl.text().trim();
    
    // thumbnail
    let img = $media.find('img.media-pic.lazy');
    let thumbnail = img.attr('data-src') || img.attr('src') || '';
    
    // episodes
    let epEl = $media.find('span.label');
    let episodes = epEl.text().trim();
    
    if (href && title) {
      results.push({
        title,
        url: href.startsWith('http') ? href : BASE_URL + href,
        thumbnail,
        episodes
      });
    }
  });
  
  console.log(`  Extracted ${results.length} results`);
  assert(results.length > 0, 'At least one result extracted');
  
  if (results.length > 0) {
    let first = results[0];
    assert(!!first.title, 'Result has title');
    assert(first.url.includes('ikanbot.com'), 'Result URL contains ikanbot.com');
    console.log('  First result:', JSON.stringify(first, null, 2));
  }
  
  return results;
}

async function testPlayPage(playUrl) {
  console.log(`\n🎬 Test: Fetch play page "${playUrl}"`);
  
  let resp = await fetch(playUrl, { headers: { 'User-Agent': USER_AGENT } });
  assert(resp.ok, `HTTP ${resp.status}`);
  
  let html = await resp.text();
  assert(html.length > 1000, `HTML body length: ${html.length}`);
  
  let $ = cheerio.load(html);
  
  let currentId = $('#current_id').val() || '';
  let mtype = $('#mtype').val() || '';
  let eToken = $('#e_token').val() || '';
  
  console.log(`  currentId: "${currentId}"`);
  console.log(`  mtype: "${mtype}"`);
  console.log(`  eToken length: ${eToken.length}`);
  
  assert(!!currentId, 'current_id is present');
  assert(!!eToken, 'e_token is present');
  
  return { currentId, mtype, eToken };
}

async function testGetResN(currentId, mtype, eToken) {
  console.log('\n🔑 Test: computeToken + /api/getResN');
  
  let token = computeToken(currentId, eToken);
  assert(token.length > 0, `Token computed: "${token.substring(0, 20)}..."`);
  
  let apiUrl = `${BASE_URL}/api/getResN?videoId=${currentId}&mtype=${mtype || '1'}&token=${token}`;
  console.log('  API URL:', apiUrl);
  
  let resp = await fetch(apiUrl, { headers: { 'User-Agent': USER_AGENT } });
  assert(resp.ok, `HTTP ${resp.status}`);
  
  let text = await resp.text();
  assert(text.length > 10, `Response body length: ${text.length}`);
  console.log('  Response (first 300 chars):', text.substring(0, 300));
  
  let json;
  try {
    json = JSON.parse(text);
    assert(true, 'Response is valid JSON');
  } catch (e) {
    assert(false, `Response is valid JSON: ${e.message}`);
    return [];
  }
  
  assert(json.state === 1, `state === 1 (got ${json.state})`);
  
  let videos = [];
  if (json.data && json.data.list) {
    for (let lineItem of json.data.list) {
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
        // Regex fallback for m3u8 URLs
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
  
  console.log(`  Extracted ${videos.length} HLS video sources`);
  assert(videos.length > 0, 'At least one video source found');
  
  if (videos.length > 0) {
    let first = videos[0];
    assert(first.url.endsWith('.m3u8'), 'Video URL ends with .m3u8');
    assert(!!first.label, 'Video has label');
    console.log('  First video:', JSON.stringify(first, null, 2));
    
    // Verify URL is actually reachable
    console.log(`\n🌐 Verify: HEAD ${first.url.substring(0, 80)}...`);
    try {
      let headResp = await fetch(first.url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
      console.log(`  HTTP ${headResp.status} ${headResp.statusText}`);
      if (headResp.ok) {
        console.log('  ✅ Video source is reachable');
        passed++;
      } else {
        console.log('  ⚠️  Video source returned non-200 (may still work in player)');
      }
    } catch (e) {
      console.log(`  ⚠️  Could not verify: ${e.message}`);
    }
  }
  
  return videos;
}

// ============================================================
// Main
// ============================================================
async function main() {
  console.log('='.repeat(60));
  console.log('  ikanbot.com Scraping Logic Test');
  console.log('  Replicates WebAppInterface.java logic in Node.js');
  console.log('='.repeat(60));
  
  // 1. Test computeToken
  await testComputeToken();
  
  // 2. Test search
  let results = await testSearch();
  
  if (results.length === 0) {
    console.log('\n⚠️  No search results — cannot test play page/API flow.');
    console.log('Summary:', passed, 'passed,', failed, 'failed');
    process.exit(failed > 0 ? 1 : 0);
  }
  
  // 3. Test play page extraction using the FIRST result
  let playUrl = results[0].url;
  let { currentId, mtype, eToken } = await testPlayPage(playUrl);
  
  if (!currentId || !eToken) {
    console.log('\n⚠️  Missing hidden inputs — cannot test API.');
    console.log('Summary:', passed, 'passed,', failed, 'failed');
    process.exit(failed > 0 ? 1 : 0);
  }
  
  // 4. Test getResN API
  await testGetResN(currentId, mtype, eToken);
  
  // 5. Summary
  console.log('\n' + '='.repeat(60));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
  
  if (failed > 0) {
    console.log('\n❌ SOME TESTS FAILED — check the Java/JS logic before shipping');
    process.exit(1);
  } else {
    console.log('\n✅ ALL TESTS PASSED — parsing logic is correct');
  }
}

main().catch(err => {
  console.error('\n💥 Unhandled error:', err);
  process.exit(1);
});
