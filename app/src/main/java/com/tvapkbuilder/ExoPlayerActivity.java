package com.tvapkbuilder;

import android.content.Intent;
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

import java.util.HashMap;
import java.util.Map;

/**
 * Fullscreen ExoPlayer activity for native HLS/MP4 playback.
 * Receives video URL via Intent extra "videoUrl".
 * Uses DefaultHttpDataSource with custom Referer header for ikanbot.com CDN access.
 */
public class ExoPlayerActivity extends AppCompatActivity {

    private static final String TAG = "ExoPlayerActivity";
    private static final String REFERER = "https://www.ikanbot.com/";

    private ExoPlayer player;
    private PlayerView playerView;

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_player);

        playerView = findViewById(R.id.playerView);

        // Get video URL from intent
        Intent intent = getIntent();
        String videoUrl = intent != null ? intent.getStringExtra("videoUrl") : null;
        String videoTitle = intent != null ? intent.getStringExtra("videoTitle") : "";

        if (videoUrl == null || videoUrl.isEmpty()) {
            Log.e(TAG, "No video URL provided");
            finish();
            return;
        }

        Log.d(TAG, "Playing: " + videoUrl + " (" + videoTitle + ")");

        // Build ExoPlayer
        player = new ExoPlayer.Builder(this).build();

        // Create data source factory with custom HTTP headers (Referer for CDN access)
        DefaultHttpDataSource.Factory dataSourceFactory = new DefaultHttpDataSource.Factory();
        Map<String, String> headers = new HashMap<>();
        headers.put("Referer", REFERER);
        headers.put("Origin", "https://www.ikanbot.com");
        dataSourceFactory.setDefaultRequestProperties(headers);

        // Use DefaultMediaSourceFactory which auto-detects HLS, MP4, etc.
        // Requires media3-exoplayer-hls on classpath for HLS detection.
        player.setMediaSourceFactory(
                new DefaultMediaSourceFactory(dataSourceFactory)
        );

        MediaItem mediaItem = MediaItem.fromUri(videoUrl);
        player.setMediaItem(mediaItem);
        player.setPlayWhenReady(true);

        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int playbackState) {
                switch (playbackState) {
                    case Player.STATE_ENDED:
                        Log.d(TAG, "Playback ended");
                        finish();
                        break;
                    case Player.STATE_BUFFERING:
                        Log.d(TAG, "Buffering...");
                        break;
                    case Player.STATE_READY:
                        Log.d(TAG, "Ready to play");
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
}
