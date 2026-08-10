package com.tvapkbuilder;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {

    private static final String TAG = "MainActivity";
    private static final String PREFS_NAME = "tvsearch_playback";
    private static final String KEY_PROGRESS = "progress_json";
    private static final String KEY_ENDED_URL = "ended_url";

    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);

        // --- WebView setup ---
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        // File access via JavaScript is not needed — app loads from bundled assets
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        // Block mixed content (HTTPS page loading HTTP resources).
        // HLS video streams fetched by HLS.js / native video element are not affected.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(
            "Mozilla/5.0 (Linux; Android 14; Android TV) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.6099.230 Safari/537.36"
        );

        // --- JavaScript bridge ---
        webView.addJavascriptInterface(
            new WebAppInterface(this),
            "Android"
        );

        // Fullscreen video support (placeholder for future ExoPlayer integration)
        webView.setWebChromeClient(new WebChromeClient());

        // --- Load web app from assets ---
        webView.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onResume() {
        super.onResume();
        // Forward ExoPlayer results back to JS:
        // - progress_json → onNativeProgressSaved() → saveHistoryEntry() (watch history + resume)
        // - ended_url     → onNativePlaybackEnded() → playNextEpisode()  (auto-play next)
        // Both keys are consumed (deleted) after forwarding so each playback
        // event is delivered exactly once.
        forwardPlaybackEvents();
    }

    /**
     * Hand playback progress / ended events from ExoPlayerActivity to app.js.
     * Runs on the UI thread; the WebView is already loaded when returning
     * from the player activity, so evaluateJavascript is safe here.
     */
    private void forwardPlaybackEvents() {
        if (webView == null) return;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);

        String progressJson = prefs.getString(KEY_PROGRESS, null);
        if (progressJson != null) {
            prefs.edit().remove(KEY_PROGRESS).apply();
            Log.d(TAG, "Forwarding progress to JS: " + progressJson);
            // progressJson is a JSON object literal → valid JS expression
            webView.evaluateJavascript(
                "window.onNativeProgressSaved && window.onNativeProgressSaved(" + progressJson + ");",
                null
            );
        }

        String endedUrl = prefs.getString(KEY_ENDED_URL, null);
        if (endedUrl != null) {
            prefs.edit().remove(KEY_ENDED_URL).apply();
            Log.d(TAG, "Forwarding ended to JS: " + endedUrl);
            webView.evaluateJavascript(
                "window.onNativePlaybackEnded && window.onNativePlaybackEnded("
                    + jsonStringLiteral(endedUrl) + ");",
                null
            );
        }
    }

    /**
     * Escape a string as a JavaScript string literal (for evaluateJavascript).
     */
    private String jsonStringLiteral(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
            }
        }
        sb.append("\"");
        return sb.toString();
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        // Handle Android TV remote back button
        if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
            webView.evaluateJavascript(
                "document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Back'}));",
                null
            );
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // onBackPressed intentionally omitted — KEYCODE_BACK is handled by onKeyDown above.
    // Using OnBackInvokedCallback (API 33+) is unnecessary for Android TV where
    // the remote always dispatches key events.
}
