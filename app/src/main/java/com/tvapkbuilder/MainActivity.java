package com.tvapkbuilder;

import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {

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
