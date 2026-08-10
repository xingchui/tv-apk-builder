package com.tvapkbuilder;

import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.util.Log;
import android.view.KeyEvent;

import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.Map;

/**
 * Fullscreen ExoPlayer activity for native HLS/MP4 playback.
 * Receives video URL via Intent extra "videoUrl".
 * Uses DefaultHttpDataSource with custom Referer header for ikanbot.com CDN access.
 *
 * Native ↔ JS bridge contract (see AGENTS.md):
 * - Playback progress is persisted to SharedPreferences on stop and handed back to
 *   MainActivity, which forwards it to app.js via onNativeProgressSaved() so the
 *   watch-history / resume-from-history feature works on the native path.
 * - When a video finishes, the "ended" flag is written and MainActivity forwards it
 *   to app.js via onNativePlaybackEnded() so auto-play-next works on the native path.
 */
public class ExoPlayerActivity extends AppCompatActivity {

    private static final String TAG = "ExoPlayerActivity";
    private static final String REFERER = "https://www.ikanbot.com/";
    private static final String PREFS_NAME = "tvsearch_playback";
    private static final String KEY_PROGRESS = "progress_json";
    private static final String KEY_ENDED_URL = "ended_url";
    private static final long MIN_SAVE_MS = 5000;      // don't save progress shorter than 5s
    private static final long END_TAIL_MS = 5000;      // treat last 5s as watched-to-end

    private ExoPlayer player;
    private PlayerView playerView;

    private String videoUrl = "";
    private String videoTitle = "";
    private long resumeTimeMs = 0;
    private boolean playbackEnded = false;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_player);

        playerView = findViewById(R.id.playerView);

        // Get video URL from intent
        Intent intent = getIntent();
        videoUrl = intent != null ? intent.getStringExtra("videoUrl") : null;
        videoTitle = intent != null ? intent.getStringExtra("videoTitle") : "";
        resumeTimeMs = intent != null ? intent.getLongExtra("videoResumeTimeMs", 0) : 0;
        float volume = intent != null ? intent.getFloatExtra("videoVolume", 1.0f) : 1.0f;

        if (videoUrl == null || videoUrl.isEmpty()) {
            Log.e(TAG, "No video URL provided");
            finish();
            return;
        }

        Log.d(TAG, "Playing: " + videoUrl + " (" + videoTitle + ")" + (resumeTimeMs > 0 ? " resume=" + resumeTimeMs + "ms" : ""));

        // Create data source factory with custom HTTP headers (Referer for CDN access)
        DefaultHttpDataSource.Factory dataSourceFactory = new DefaultHttpDataSource.Factory();
        Map<String, String> headers = new HashMap<>();
        headers.put("Referer", REFERER);
        headers.put("Origin", "https://www.ikanbot.com");
        dataSourceFactory.setDefaultRequestProperties(headers);

        // Build ExoPlayer with custom data source via DefaultMediaSourceFactory
        // DefaultMediaSourceFactory auto-detects HLS, MP4, etc.
        // Requires media3-exoplayer-hls on classpath for HLS detection.
        player = new ExoPlayer.Builder(this)
                .setMediaSourceFactory(
                        new DefaultMediaSourceFactory(dataSourceFactory))
                .build();

        // Persisted JS volume level (0.0-1.0) applied to the player. The TV remote
        // volume keys still control system volume on top of this.
        player.setVolume(Math.max(0.0f, Math.min(1.0f, volume)));

        MediaItem mediaItem = MediaItem.fromUri(videoUrl);
        player.setMediaItem(mediaItem);
        player.setPlayWhenReady(true);

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                switch (playbackState) {
                    case Player.STATE_ENDED:
                        playbackEnded = true;
                        Log.d(TAG, "Playback ended");
                        markEndedForAutoNext();
                        finish();
                        break;
                    case Player.STATE_BUFFERING:
                        Log.d(TAG, "Buffering...");
                        break;
                    case Player.STATE_READY:
                        Log.d(TAG, "Ready to play");
                        // Seek to resume position only after the source is ready
                        // so the seek lands on real boundaries (HLS included).
                        if (resumeTimeMs > 0) {
                            player.seekTo(resumeTimeMs);
                            resumeTimeMs = 0;
                        }
                        break;
                    case Player.STATE_IDLE:
                        break;
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                Log.e(TAG, "Playback error: " + error.getMessage());
            }
        });

        // Attach player to view
        playerView.setPlayer(player);
        playerView.setUseController(true);
        playerView.setKeepScreenOn(true);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK || keyCode == KeyEvent.KEYCODE_ESCAPE) {
            finish();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onStop() {
        super.onStop();
        saveProgress();
        releasePlayer();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        releasePlayer();
    }

    private void releasePlayer() {
        if (player != null) {
            player.stop();
            player.release();
            player = null;
        }
    }

    /**
     * Persist playback progress so MainActivity can forward it to JS on resume.
     * Only saved when the user actually watched something (>= 5s) and did not
     * watch it to the end (last 5s counts as finished).
     */
    private void saveProgress() {
        if (playbackEnded || player == null) return;
        long position = player.getCurrentPosition();
        long duration = player.getDuration();
        if (position <= MIN_SAVE_MS) return;
        if (duration > 0 && position > duration - END_TAIL_MS) return; // watched to end

        try {
            JSONObject json = new JSONObject();
            json.put("url", videoUrl);
            json.put("title", videoTitle);
            json.put("positionMs", position);
            json.put("durationMs", duration);
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .edit()
                    .putString(KEY_PROGRESS, json.toString())
                    .apply();
            Log.d(TAG, "Saved progress: " + position + "ms / " + duration + "ms");
        } catch (Exception e) {
            Log.e(TAG, "Failed to save progress", e);
        }
    }

    /**
     * Record the finished video URL so MainActivity can notify JS for auto-next.
     */
    private void markEndedForAutoNext() {
        try {
            getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .edit()
                    .putString(KEY_ENDED_URL, videoUrl)
                    .apply();
        } catch (Exception e) {
            Log.e(TAG, "Failed to mark ended", e);
        }
    }
}
