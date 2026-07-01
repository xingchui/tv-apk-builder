package com.tvapkbuilder;

import android.app.Activity;
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
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.Scanner;

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

            // Match the actual DOM structure of ikanbot.com search results:
            // <div class="media">
            //   <div class="media-left media-top">
            //     <a class="cover-link" href="/play/663079">
            //       <img class="media-object media-pic lazy" data-src="https://..." alt="四渡赤水"/>
            //     </a>
            //   </div>
            //   <div class="media-body">
            //     <h5 class="media-heading">
            //       <a class="title-text" href="/play/663079">四渡赤水  1983</a>
            //       <span class="label">[19条线路可播放]</span>
            //     </h5>
            //   </div>
            // </div>
            Elements mediaItems = doc.select("div.media");
            for (Element media : mediaItems) {
                // Extract play page link from cover-link
                Element coverLink = media.selectFirst("a.cover-link");
                if (coverLink == null) continue;
                String href = coverLink.attr("href");
                if (href.isEmpty()) continue;
                String fullUrl = href.startsWith("http") ? href : BASE_URL + href;

                // Extract title from title-text
                Element titleEl = media.selectFirst("a.title-text");
                String title = titleEl != null ? titleEl.text().trim() : "";
                if (title.isEmpty()) continue;
                // Truncate overly long titles
                if (title.length() > 100) title = title.substring(0, 100);

                // Extract thumbnail from lazy-loaded image
                String thumbnail = "";
                Element img = media.selectFirst("img.media-pic.lazy");
                if (img != null) {
                    thumbnail = img.attr("data-src");
                    if (thumbnail.isEmpty()) thumbnail = img.attr("src");
                    if (!thumbnail.isEmpty() && !thumbnail.startsWith("http")) {
                        if (thumbnail.startsWith("//")) {
                            thumbnail = "https:" + thumbnail;
                        } else if (!thumbnail.startsWith("data:")) {
                            thumbnail = "https:" + thumbnail;
                        }
                    }
                }

                // Extract episode count from label
                String episodes = "";
                Element epEl = media.selectFirst("span.label");
                if (epEl != null) {
                    episodes = epEl.text().trim();
                }

                JSONObject item = new JSONObject();
                item.put("title", title);
                item.put("url", fullUrl);
                item.put("thumbnail", thumbnail);
                item.put("episodes", episodes);
                results.put(item);

                if (results.length() >= 20) break;
            }

            JSONObject wrapper = new JSONObject();
            wrapper.put("results", results);
            Log.d(TAG, "Found " + results.length() + " results via div.media selectors");
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
     * Uses the ikanbot.com internal API: /api/getResN
     */
    @JavascriptInterface
    public String getPlayInfo(String pageUrl) {
        if (pageUrl == null || pageUrl.isEmpty()) {
            return "{\"videos\":[]}";
        }

        try {
            Log.d(TAG, "Fetching play page: " + pageUrl);

            // Step 1: Fetch play page to get hidden inputs (current_id, mtype, e_token)
            Document doc = Jsoup.connect(pageUrl)
                    .userAgent("Mozilla/5.0 (Linux; Android 14; Android TV) AppleWebKit/537.36")
                    .timeout(TIMEOUT_MS)
                    .followRedirects(true)
                    .get();

            String currentId = doc.select("#current_id").val();
            String mtype = doc.select("#mtype").val();
            String eToken = doc.select("#e_token").val();

            if (currentId.isEmpty() || eToken.isEmpty()) {
                Log.e(TAG, "Missing hidden inputs: currentId=" + currentId + ", eToken=" + eToken);
                return "{\"videos\":[]}";
            }

            Log.d(TAG, "currentId=" + currentId + ", mtype=" + mtype + ", eToken.length=" + eToken.length());

            // Step 2: Compute v_tks token (same algorithm as play_new.js)
            String token = computeToken(currentId, eToken);
            Log.d(TAG, "Computed token=" + token);

            // Step 3: Call /api/getResN
            String apiUrl = BASE_URL + "/api/getResN?videoId=" + currentId
                    + "&mtype=" + (mtype.isEmpty() ? "1" : mtype)
                    + "&token=" + token;
            Log.d(TAG, "Calling API: " + apiUrl);

            String apiResponse = httpGet(apiUrl);
            Log.d(TAG, "API response: " + (apiResponse.length() > 200 ? apiResponse.substring(0, 200) + "..." : apiResponse));

            // Step 4: Parse API response
            JSONObject responseJson = new JSONObject(apiResponse);
            int state = responseJson.optInt("state", 0);
            if (state != 1) {
                Log.w(TAG, "API returned state=" + state);
                return "{\"videos\":[]}";
            }

            JSONArray videos = new JSONArray();
            JSONObject dataObj = responseJson.optJSONObject("data");
            if (dataObj != null) {
                JSONArray list = dataObj.optJSONArray("list");
                if (list != null) {
                    for (int i = 0; i < list.length(); i++) {
                        JSONObject lineItem = list.getJSONObject(i);
                        String resDataStr = lineItem.optString("resData", "");
                        if (resDataStr.isEmpty()) continue;

                        // resData is a JSON string (array of objects with "url" and "newName")
                        // Example: [{"url":"高清$https://...m3u8#标清$https://...m3u8","newName":""}]
                        try {
                            JSONArray resArray = new JSONArray(resDataStr);
                            for (int j = 0; j < resArray.length(); j++) {
                                JSONObject resObj = resArray.getJSONObject(j);
                                String urlData = resObj.optString("url", "");
                                if (urlData.isEmpty()) continue;

                                // urlData format: "name$url#name$url#..."
                                String[] entries = urlData.split("#");
                                for (String entry : entries) {
                                    String[] parts = entry.split("\\$", 2);
                                    if (parts.length >= 2) {
                                        String label = parts[0].trim();
                                        String videoUrl = parts[1].trim();
                                        if (videoUrl.toLowerCase().endsWith(".m3u8")) {
                                            JSONObject video = new JSONObject();
                                            video.put("url", videoUrl);
                                            video.put("label", label.isEmpty() ? ("线路 " + (videos.length() + 1)) : label);
                                            videos.put(video);
                                        }
                                    }
                                }
                            }
                        } catch (Exception e) {
                            // If JSON parsing fails, try regex fallback for m3u8 URLs
                            Log.w(TAG, "resData JSON parse failed, trying regex fallback", e);
                            java.util.regex.Matcher m = java.util.regex.Pattern
                                    .compile("https?://[^\"'\\s,]+?\\.m3u8[^\"'\\s,]*")
                                    .matcher(resDataStr);
                            while (m.find()) {
                                String m3u8Url = m.group();
                                JSONObject video = new JSONObject();
                                video.put("url", m3u8Url);
                                video.put("label", "视频源 " + (videos.length() + 1));
                                // Deduplicate
                                boolean dup = false;
                                for (int k = 0; k < videos.length(); k++) {
                                    if (videos.getJSONObject(k).getString("url").equals(m3u8Url)) {
                                        dup = true;
                                        break;
                                    }
                                }
                                if (!dup) videos.put(video);
                            }
                        }
                    }
                }
            }

            JSONObject wrapper = new JSONObject();
            wrapper.put("videos", videos);
            Log.d(TAG, "Found " + videos.length() + " video sources via API");
            return wrapper.toString();

        } catch (IOException e) {
            Log.e(TAG, "getPlayInfo IO error", e);
            return "{\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
        } catch (Exception e) {
            Log.e(TAG, "getPlayInfo parse error", e);
            return "{\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
        }
    }

    /**
     * Exit the app (called from JS when back is pressed on search screen).
     */
    @JavascriptInterface
    public void exitApp() {
        Log.d(TAG, "exitApp called");
        if (context instanceof Activity) {
            ((Activity) context).finish();
        }
    }

    /**
     * Debug logging from JavaScript.
     */
    @JavascriptInterface
    public void log(String message) {
        Log.d(TAG, "[JS] " + message);
    }

    // ---- Private helpers ----

    /**
     * Compute the v_tks token used by ikanbot.com's API.
     * Algorithm from play_new.js get_tks():
     *   suffix = last 4 chars of currentId
     *   for each digit in suffix:
     *     offset = digit % 3 + 1
     *     arr[i] = eToken.substring(offset, offset+8)
     *     eToken = eToken.substring(offset+8)
     *   v_tks = arr.join('')
     */
    private String computeToken(String currentId, String eToken) {
        int len = currentId.length();
        String suffix = currentId.substring(len - 4, len);
        StringBuilder sb = new StringBuilder();
        String remaining = eToken;
        for (int i = 0; i < suffix.length(); i++) {
            int digit = Character.getNumericValue(suffix.charAt(i));
            int offset = (digit % 3) + 1;
            if (offset + 8 > remaining.length()) break;
            sb.append(remaining, offset, offset + 8);
            remaining = remaining.substring(offset + 8);
        }
        return sb.toString();
    }

    /**
     * Simple HTTP GET request returning the response body as a String.
     */
    private String httpGet(String urlStr) throws IOException {
        URL url = URI.create(urlStr).toURL();
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setRequestMethod("GET");
        conn.setRequestProperty("User-Agent",
                "Mozilla/5.0 (Linux; Android 14; Android TV) AppleWebKit/537.36");
        conn.setConnectTimeout(TIMEOUT_MS);
        conn.setReadTimeout(TIMEOUT_MS);
        conn.setInstanceFollowRedirects(true);

        int status = conn.getResponseCode();
        if (status != 200) {
            throw new IOException("HTTP " + status + " for " + urlStr);
        }

        Scanner scanner = new Scanner(conn.getInputStream(), StandardCharsets.UTF_8.name());
        scanner.useDelimiter("\\A");
        String body = scanner.hasNext() ? scanner.next() : "";
        scanner.close();
        conn.disconnect();
        return body;
    }
}
