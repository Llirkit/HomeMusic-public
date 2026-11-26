package ru.llirkit.homemusic;

import android.app.PendingIntent;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
import android.net.Uri;
import androidx.media3.common.*;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.session.*;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.*;

@androidx.media3.common.util.UnstableApi
public final class PlaybackService extends MediaSessionService {
  static PlaybackService current;
  Consumer<String> onlineListener;
  private MediaSession session;
  private ExoPlayer player;
  private String onlineId = "";
  private int cycle;
  private String radioToken = "", radioUrl = "";
  private int radioGeneration;
  private boolean radioBusy, radioListening, radioPaused;
  private float radioVolume = 0.65f;
  private final RadioEqualizer radioEqualizer = new RadioEqualizer();
  private long radioNextAt;
  private final ExecutorService radioNetwork = Executors.newSingleThreadExecutor();
  private volatile String currentStream = "";
  private JSONObject connectConfig;
  private boolean connectInBackground, connectBusy;
  private int connectGeneration;
  private long connectNextAt;
  private final ExecutorService connectNetwork = Executors.newSingleThreadExecutor();
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final Runnable onlineTick = new Runnable() {
    @Override public void run() { publishOnline(); pollRadio(); pollConnect(); handler.postDelayed(this, 1000); }
  };

  @Override
  public void onCreate() {
    super.onCreate();
    current = this;
    DefaultDataSource.Factory data = new DefaultDataSource.Factory(this, () -> new HubAudioDataSource(
        getSharedPreferences("app", MODE_PRIVATE).getString("server", BuildConfig.SERVER_URL), () -> currentStream));
    player = new ExoPlayer.Builder(this).setMediaSourceFactory(new DefaultMediaSourceFactory(data)).build();
    player.setWakeMode(C.WAKE_MODE_NETWORK);
    // Load the next item's first ten seconds only after the current item's buffer is satisfied.
    player.setPreloadConfiguration(new ExoPlayer.PreloadConfiguration(10_000_000L));
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
    player.addListener(new Player.Listener() {
      @Override public void onMediaItemTransition(MediaItem item, int reason) {
        currentStream = item != null && item.localConfiguration != null ? item.localConfiguration.uri.toString() : "";
        if (reason == Player.MEDIA_ITEM_TRANSITION_REASON_REPEAT) cycle++;
      }
      @Override public void onAudioSessionIdChanged(int id) {
        if (isRadio()) { radioEqualizer.attach(id); applyRadioVolume(); }
      }
      @Override public void onPlayWhenReadyChanged(boolean ready, int reason) {
        if (isRadio() && !radioPaused) radioListening = ready;
        if (isRadio() && radioPaused && ready) player.pause();
      }
      @Override public void onEvents(Player p, Player.Events events) { publishOnline(); }
    });
    handler.post(onlineTick);
  }

  void onlineCommand(JSONObject message) throws JSONException {
    String op = message.getString("op"), id = message.optString("id");
    if (op.equals("connect")) {
      connectGeneration++;
      connectConfig = message.optBoolean("enabled") ? new JSONObject(message.toString()) : null;
      connectNextAt = 0;
      return;
    }
    if (op.equals("radio")) {
      String token = message.getString("token");
      if (!token.matches("[A-Za-z0-9_-]{20,48}") || !id.equals("radio:" + token)) return;
      stopOnline();
      onlineId = id;
      radioToken = token;
      radioNextAt = 0;
      radioListening = true;
      radioVolume = (float) Math.max(0, Math.min(1, message.optDouble("volume", 0.65)));
      radioEqualizer.settings(message);
      radioEqualizer.attach(player.getAudioSessionId());
      applyRadioVolume();
      player.setPlayWhenReady(true);
      session.setSessionActivity(PendingIntent.getActivity(this, 2, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
      pollRadio();
      return;
    }
    if (op.equals("load") || op.equals("queue")) {
      if (op.equals("queue") && !id.equals(onlineId)) return;
      JSONArray tracks = message.getJSONArray("queue");
      int index = message.getInt("index");
      if (id.isEmpty() || tracks.length() == 0 || tracks.length() > 5000 || index < 0 || index >= tracks.length()) return;
      if (connectConfig != null) {
        JSONObject checkpoint = connectConfig.optJSONObject("snapshot");
        if (checkpoint != null) {
          checkpoint.put("queue", tracks).put("index", index).put("context", message.optString("context", checkpoint.optString("context")));
          checkpoint.put("shuffle", message.optBoolean("shuffle")).put("smart", message.optBoolean("smart"));
          checkpoint.put("repeat", message.optString("repeat", "off"));
        }
      }
      String base = getSharedPreferences("app", MODE_PRIVATE).getString("server", BuildConfig.SERVER_URL);
      List<MediaItem> items = new ArrayList<>();
      for (int i = 0; i < tracks.length(); i++) {
        JSONObject track = tracks.getJSONObject(i);
        String ref = track.getString("ref");
        if (ref.isEmpty() || ref.length() > 2048) return;
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .setTitle(track.optString("title")).setArtist(track.optString("artist")).setAlbumTitle(track.isNull("album") ? "" : track.optString("album"));
        String cover = track.optString("cover_url");
        if (cover.startsWith("/")) cover = base + cover;
        if (Identity.sameOrigin(base, cover)) metadata.setArtworkUri(Uri.parse(cover));
        items.add(new MediaItem.Builder().setMediaId("online:" + i + ":" + ref)
            .setUri(base + "/api/listen/stream?ref=" + Api.encode(ref)).setMediaMetadata(metadata.build()).build());
      }
      boolean load = op.equals("load");
      radioToken = ""; radioUrl = ""; radioGeneration++;
      radioEqualizer.release(); radioListening = false; radioPaused = false;
      boolean playing = !load && player.getPlayWhenReady();
      long position = load ? Math.max(0, (long) (message.optDouble("position") * 1000)) : player.getCurrentPosition();
      onlineId = id;
      currentStream = items.get(index).localConfiguration.uri.toString();
      if (load) cycle = 0;
      player.setPlayWhenReady(playing);
      player.setMediaItems(items, index, position);
      String repeat = message.optString("repeat");
      player.setRepeatMode(repeat.equals("one") ? Player.REPEAT_MODE_ONE : repeat.equals("all") ? Player.REPEAT_MODE_ALL : Player.REPEAT_MODE_OFF);
      player.setVolume((float) Math.max(0, Math.min(1, message.optDouble("volume", 1))));
      session.setSessionActivity(PendingIntent.getActivity(this, 2, new Intent(this, MainActivity.class), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
      player.prepare();
    } else if (!onlineId.isEmpty() && id.equals(onlineId)) {
      switch (op) {
        case "play": if (isRadio()) { radioListening = true; radioNextAt = 0; pollRadio(); } else player.play(); break;
        case "pause": if (isRadio()) radioListening = false; player.pause(); break;
        case "seek": player.seekTo(Math.max(0, (long) (message.optDouble("position") * 1000))); break;
        case "volume":
          float volume = (float) Math.max(0, Math.min(1, message.optDouble("volume", 1)));
          if (isRadio()) { radioVolume = volume; applyRadioVolume(); } else player.setVolume(volume);
          break;
        case "equalizer":
          if (isRadio()) { radioEqualizer.settings(message); radioEqualizer.attach(player.getAudioSessionId()); applyRadioVolume(); }
          break;
        case "stop": stopOnline(); return;
        default: return;
      }
    }
    publishOnline();
  }

  void stopOnline() {
    boolean wasRadio = isRadio();
    radioToken = ""; radioUrl = ""; radioGeneration++;
    radioListening = false; radioPaused = false; radioEqualizer.release();
    if (wasRadio) player.setVolume(1);
    String previous = onlineId;
    onlineId = "";
    player.stop();
    player.clearMediaItems();
    player.setRepeatMode(Player.REPEAT_MODE_OFF);
    if (!previous.isEmpty() && onlineListener != null) {
      try { onlineListener.accept(new JSONObject().put("id", previous).put("state", -1).toString()); }
      catch (JSONException ignored) { }
    }
    session.setSessionActivity(PendingIntent.getActivity(this, 1, new Intent(this, MainActivity.class).putExtra("offline", true), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
  }

  void connectBackground(boolean background) {
    connectInBackground = background;
    connectGeneration++;
    connectNextAt = 0;
  }

  void disconnectAccount() { connectConfig = null; connectGeneration++; }

  /** Native polling owns the lease while WebView timers are suspended. Offline music is never uploaded. */
  private void pollConnect() {
    if (!connectInBackground || connectConfig == null || connectBusy || isRadio()
        || android.os.SystemClock.elapsedRealtime() < connectNextAt) return;
    final int generation = connectGeneration;
    final String base = getSharedPreferences("app", MODE_PRIVATE).getString("server", BuildConfig.SERVER_URL);
    final JSONObject body;
    try {
      body = new JSONObject().put("account_id", connectConfig.getInt("account_id"))
          .put("device_id", connectConfig.getString("device_id")).put("name", connectConfig.getString("name"))
          .put("revision", connectConfig.getInt("revision"));
      JSONObject checkpoint = connectConfig.optJSONObject("snapshot");
      if (connectConfig.optBoolean("owner") && checkpoint != null) {
        checkpoint = new JSONObject(checkpoint.toString());
        if (!onlineId.isEmpty()) checkpoint.put("index", player.getCurrentMediaItemIndex()).put("position", player.getCurrentPosition() / 1000d);
        checkpoint.put("autoplay", !onlineId.isEmpty() && player.getPlayWhenReady() && player.getPlaybackState() != Player.STATE_ENDED && player.getPlayerError() == null);
        body.put("snapshot", checkpoint);
      }
    } catch (JSONException e) { return; }
    connectBusy = true;
    connectNetwork.execute(() -> {
      JSONObject result = null;
      boolean loginRequired = false;
      try { result = Api.post(base, "/api/playback/heartbeat", body); }
      catch (Api.LoginRequired e) { loginRequired = true; }
      catch (Exception ignored) { /* transient failures retry without replacing the offline queue */ }
      final JSONObject response = result;
      final boolean expired = loginRequired;
      handler.post(() -> {
        connectBusy = false;
        connectNextAt = android.os.SystemClock.elapsedRealtime() + 2000;
        if (generation != connectGeneration || connectConfig == null || !connectInBackground) return;
        if (expired) { connectConfig = null; if (!onlineId.isEmpty()) stopOnline(); return; }
        if (response == null) return;
        try {
          boolean owner = connectConfig.getString("device_id").equals(response.optString("device_id"));
          boolean changed = connectConfig.getInt("revision") != response.getInt("revision");
          boolean wasOwner = connectConfig.optBoolean("owner");
          connectConfig.put("revision", response.getInt("revision")).put("owner", owner);
          JSONObject checkpoint = response.optJSONObject("snapshot");
          if (!owner && wasOwner && !onlineId.isEmpty()) player.pause();
          if (owner && changed && checkpoint != null) {
            connectConfig.put("snapshot", new JSONObject(checkpoint.toString()));
            JSONObject load = new JSONObject(checkpoint.toString()).put("op", "load")
                .put("id", java.util.UUID.randomUUID().toString()).put("volume", player.getVolume());
            onlineCommand(load);
            player.setPlayWhenReady(checkpoint.optBoolean("autoplay"));
          }
        } catch (JSONException ignored) { }
      });
    });
  }

  boolean isOnline() { return !onlineId.isEmpty(); }
  boolean isRadio() { return !radioToken.isEmpty(); }

  private void pollRadio() {
    if (radioToken.isEmpty() || radioBusy || !radioListening
        || android.os.SystemClock.elapsedRealtime() < radioNextAt) return;
    final String token = radioToken;
    final int generation = radioGeneration;
    final String base = getSharedPreferences("app", MODE_PRIVATE).getString("server", BuildConfig.SERVER_URL);
    radioBusy = true;
    radioNetwork.execute(() -> {
      try {
        JSONObject broadcast = new JSONObject(Api.text(base, "/api/publications/" + token + "/radio"));
        String path = broadcast.getString("stream_url");
        if (!path.startsWith("/api/publications/" + token + "/audio/")) throw new IllegalArgumentException("Неверный адрес эфира");
        JSONObject track = broadcast.getJSONObject("track");
        long position = Math.max(0, (long) (broadcast.getDouble("position_s") * 1000));
        MediaMetadata metadata = new MediaMetadata.Builder().setTitle(track.optString("title"))
            .setArtist(track.optString("artist")).setAlbumTitle(broadcast.optString("title")).build();
        MediaItem item = new MediaItem.Builder().setMediaId("radio:" + token).setUri(base + path).setMediaMetadata(metadata).build();
        handler.post(() -> {
          radioBusy = false;
          if (generation != radioGeneration || !radioToken.equals(token)) return;
          radioNextAt = android.os.SystemClock.elapsedRealtime() + 3000;
          radioPaused = broadcast.optBoolean("paused", false);
          if (radioPaused) { player.pause(); publishOnline(); return; }
          if (!radioListening) return;
          if (!path.equals(radioUrl) || player.getPlaybackState() == Player.STATE_IDLE || player.getPlayerError() != null) {
            radioUrl = path;
            currentStream = base + path;
            player.setRepeatMode(Player.REPEAT_MODE_OFF);
            player.setMediaItem(item, position);
            player.prepare();
          } else if (Math.abs(player.getCurrentPosition() - position) > 2500) player.seekTo(position);
          player.setPlayWhenReady(radioListening);
        });
      } catch (Exception e) {
        handler.post(() -> {
          radioBusy = false;
          if (generation != radioGeneration || !radioToken.equals(token)) return;
          radioNextAt = android.os.SystemClock.elapsedRealtime() + 5000;
          player.stop();
          if (String.valueOf(e.getMessage()).contains("HTTP 404")) stopOnline();
          else if (onlineListener != null) {
            try { onlineListener.accept(new JSONObject().put("id", onlineId).put("state", -2).toString()); }
            catch (JSONException ignored) { }
          }
        });
      }
    });
  }

  private void applyRadioVolume() { player.setVolume(radioVolume * radioEqualizer.headroom()); }

  private void publishOnline() {
    if (onlineId.isEmpty() || onlineListener == null) return;
    try {
      onlineListener.accept(new JSONObject().put("id", onlineId).put("index", player.getCurrentMediaItemIndex())
          .put("position", player.getCurrentPosition() / 1000d).put("duration", player.getDuration() > 0 ? player.getDuration() / 1000d : 0)
          .put("playing", player.isPlaying()).put("playWhenReady", player.getPlayWhenReady())
          .put("radioConnected", isRadio() && radioListening).put("eqSupported", radioEqualizer.supported())
          .put("state", player.getPlaybackState()).put("cycle", cycle).put("error", player.getPlayerError() != null).toString());
    } catch (JSONException ignored) { }
  }

  @Override
  public MediaSession onGetSession(MediaSession.ControllerInfo c) {
    return session;
  }

  @Override
  public void onDestroy() {
    connectGeneration++;
    connectNetwork.shutdownNow();
    radioGeneration++;
    radioNetwork.shutdownNow();
    radioEqualizer.release();
    handler.removeCallbacks(onlineTick);
    onlineListener = null;
    current = null;
    if (session != null) {
      session.getPlayer().release();
      session.release();
    }
    super.onDestroy();
  }
}
