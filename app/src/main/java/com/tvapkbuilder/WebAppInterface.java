package com.tvapkbuilder;

import android.content.Context;
import android.util.Log;
import android.webkit.JavascriptInterface;

import org.json.JSONArray;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Document;
import org.jsoup.nodes.Element;
import org.jsoup.select.Elements;

import java.io.IOException;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;

/**
 * JavaScript bridge for scraping ikanbot.com.
 * Exposed to the WebView as "Android" object.
 */
public class WebAppInterface {

    private static final String TAG = "WebAppInterface";
    private static final String BASE_URL = "https://www.ikanbot.com";
    private static final int TIMEOUT_MS = 15000;

    private final Context context;

    public WebAppInterface(Context context) {
        this.context = context;
    }

    /**
     * Search ikanbot.com for the given query.
     * Called from JavaScript: Android.search(query)
     *
     * @param query search keyword
     * @return JSON string: {"results": [{"title":..., "url":..., "thumbnail":..., "episodes":...}]}
     */
    @JavascriptInterface
    public String search(String query) {
        if (query == null || query.trim().isEmpty()) {
            return "{\"results\":[]}";
        }

        try {
            String encoded = URLEncoder.encode(query.trim(), StandardCharsets.UTF_8.toString());
            String url = BASE_URL + "/search?q=" + encoded;
            Log.d(TAG, "Searching: " + url);

            Document doc = Jsoup.connect(url)
                    .userAgent("Mozilla/5.0 (Linux; Android 14; Android TV) AppleWebKit/537.36")
                    .timeout(TIMEOUT_MS)
                    .followRedirects(true)
                    .get();

            JSONArray results = new JSONArray();

            // Try multiple selector strategies
            Elements items = doc.select("a.video-pic, a.video-item, .search-result a, .module-item a, a[href*='/play/']");
            if (items.isEmpty()) {
                // Fallback: look for any link containing /play/
                items = doc.select("a[href*='/play/']");
            }

            // Deduplicate by href
            java.util.HashSet<String> seen = new java.util.HashSet<>();

            for (Element link : items) {
                String href = link.attr("href");
                if (href.isEmpty()) continue;

                // Normalize relative URL
                String fullUrl = href.startsWith("http") ? href : BASE_URL + href;
                if (seen.contains(fullUrl)) continue;
                seen.add(fullUrl);

                // Extract title
                String title = link.attr("title");
                if (title.isEmpty()) {
                    title = link.attr("alt");
                }
                if (title.isEmpty()) {
                    Element titleEl = link.select("img").first();
                    if (titleEl != null) title = titleEl.attr("alt");
                }
                if (title.isEmpty()) {
                    title = link.text().trim();
                }
                if (title.isEmpty() || title.length() > 100) continue;

                // Extract thumbnail
                String thumbnail = "";
                Element img = link.select("img").first();
                if (img != null) {
                    thumbnail = img.attr("data-src");
                    if (thumbnail.isEmpty()) thumbnail = img.attr("src");
                    if (!thumbnail.isEmpty() && !thumbnail.startsWith("http")) {
                        thumbnail = "https:" + thumbnail;
                    }
                }

                // Extract episode count
                String episodes = "";
                Element epEl = link.select(".ep, .number, .score, .hdtag, .tips").first();
                if (epEl != null) {
                    episodes = epEl.text().trim();
                }

                JSONObject item = new JSONObject();
                item.put("title", title);
                item.put("url", fullUrl);
                item.put("thumbnail", thumbnail);
                item.put("episodes", episodes);
                results.put(item);

                if (results.length() >= 20) break; // limit results
            }

            // If no structured results found, try broader parsing
            if (results.length() == 0) {
                Elements allLinks = doc.select("a[href]");
                for (Element link : allLinks) {
                    String href = link.attr("href");
                    if (!href.contains("/play/") && !href.contains("/detail/")) continue;

                    String fullUrl = href.startsWith("http") ? href : BASE_URL + href;
                    if (seen.contains(fullUrl)) continue;
                    seen.add(fullUrl);

                    String title = link.text().trim();
                    if (title.isEmpty() || title.length() > 100) continue;

                    JSONObject item = new JSONObject();
                    item.put("title", title);
                    item.put("url", fullUrl);
                    item.put("thumbnail", "");
                    item.put("episodes", "");
                    results.put(item);

                    if (results.length() >= 20) break;
                }
            }

            JSONObject wrapper = new JSONObject();
            wrapper.put("results", results);
            Log.d(TAG, "Found " + results.length() + " results");
            return wrapper.toString();

        } catch (IOException e) {
            Log.e(TAG, "Search error", e);
            return "{\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
        } catch (Exception e) {
            Log.e(TAG, "Parse error", e);
            return "{\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
        }
    }

    /**
     * Get video play info from a play page URL.
     * Called from JavaScript: Android.getPlayInfo(url)
     *
     * @param pageUrl full URL to the play page
     * @return JSON string: {"videos": [{"url":..., "label":...}]}
     */
    @JavascriptInterface
    public String getPlayInfo(String pageUrl) {
        if (pageUrl == null || pageUrl.isEmpty()) {
            return "{\"videos\":[]}";
        }

        try {
            Log.d(TAG, "Fetching play page: " + pageUrl);

            Document doc = Jsoup.connect(pageUrl)
                    .userAgent("Mozilla/5.0 (Linux; Android 14; Android TV) AppleWebKit/537.36")
                    .timeout(TIMEOUT_MS)
                    .followRedirects(true)
                    .get();

            JSONArray videos = new JSONArray();

            // Method 1: Look for div[name="lineData"] with udata attribute (observed format)
            Elements lineDataDivs = doc.select("div[name='lineData']");
            for (Element div : lineDataDivs) {
                String udata = div.attr("udata");
                if (!udata.isEmpty()) {
                    JSONObject video = new JSONObject();
                    video.put("url", udata);
                    video.put("label", "线路 " + (videos.length() + 1));
                    videos.put(video);
                }
            }

            // Method 2: Look for source tags with m3u8
            if (videos.length() == 0) {
                Elements sources = doc.select("source[src*=.m3u8], video source[src]");
                for (Element src : sources) {
                    String srcUrl = src.attr("src");
                    if (!srcUrl.isEmpty()) {
                        String fullSrc = srcUrl.startsWith("http") ? srcUrl :
                                (srcUrl.startsWith("//") ? "https:" + srcUrl : BASE_URL + srcUrl);
                        JSONObject video = new JSONObject();
                        video.put("url", fullSrc);
                        video.put("label", src.attr("title"));
                        videos.put(video);
                    }
                }
            }

            // Method 3: Look for iframe with video player
            if (videos.length() == 0) {
                Elements iframes = doc.select("iframe[src*='m3u8'], iframe[src*='play'], iframe[src*='video']");
                for (Element iframe : iframes) {
                    String src = iframe.attr("src");
                    if (!src.isEmpty()) {
                        String fullSrc = src.startsWith("http") ? src :
                                (src.startsWith("//") ? "https:" + src : BASE_URL + src);
                        JSONObject video = new JSONObject();
                        video.put("url", fullSrc);
                        video.put("label", iframe.attr("title"));
                        videos.put(video);
                    }
                }
            }

            // Method 4: Extract from inline script data
            if (videos.length() == 0) {
                Elements scripts = doc.select("script");
                for (Element script : scripts) {
                    String data = script.data();
                    if (data.contains(".m3u8")) {
                        // Extract m3u8 URLs with simple regex
                        java.util.regex.Matcher m = java.util.regex.Pattern
                                .compile("https?://[^\"'\\s]+\\.m3u8[^\"'\\s]*")
                                .matcher(data);
                        while (m.find()) {
                            String m3u8Url = m.group();
                            JSONObject video = new JSONObject();
                            video.put("url", m3u8Url);
                            video.put("label", "视频源 " + (videos.length() + 1));
                            videos.put(video);
                        }
                    }
                }
            }

            JSONObject wrapper = new JSONObject();
            wrapper.put("videos", videos);
            Log.d(TAG, "Found " + videos.length() + " video sources");
            return wrapper.toString();

        } catch (IOException e) {
            Log.e(TAG, "getPlayInfo error", e);
            return "{\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
        } catch (Exception e) {
            Log.e(TAG, "Parse error", e);
            return "{\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
        }
    }

    /**
     * Debug logging from JavaScript.
     */
    @JavascriptInterface
    public void log(String message) {
        Log.d(TAG, "[JS] " + message);
    }
}
