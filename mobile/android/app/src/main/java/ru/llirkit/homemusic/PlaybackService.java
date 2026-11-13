package ru.llirkit.homemusic;

import android.app.PendingIntent;
import android.content.Intent;
import androidx.media3.common.*;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.session.*;

@androidx.media3.common.util.UnstableApi
public final class PlaybackService extends MediaSessionService {
  private MediaSession session;

  @Override
  public void onCreate() {
    super.onCreate();
    ExoPlayer player = new ExoPlayer.Builder(this).build();
    player.setAudioAttributes(
        new AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build(),
        true);
    player.setHandleAudioBecomingNoisy(true);
    PendingIntent open =
        PendingIntent.getActivity(
            this,
            1,
            new Intent(this, MainActivity.class).putExtra("offline", true),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    session = new MediaSession.Builder(this, player).setSessionActivity(open).build();
  }

  @Override
  public MediaSession onGetSession(MediaSession.ControllerInfo c) {
    return session;
  }

  @Override
  public void onDestroy() {
    if (session != null) {
      session.getPlayer().release();
      session.release();
    }
    super.onDestroy();
  }
}
