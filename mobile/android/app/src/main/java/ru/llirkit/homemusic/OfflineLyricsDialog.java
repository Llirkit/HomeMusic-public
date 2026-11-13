package ru.llirkit.homemusic;

import android.app.Activity;
import android.app.Dialog;
import android.graphics.Color;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.view.MotionEvent;
import android.view.View;
import android.view.Window;
import android.widget.*;
import androidx.media3.common.MediaItem;
import androidx.media3.session.MediaController;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/** Тот же JSON Хаба в нативном офлайн-плеере; сеть не нужна для сохранённого текста. */
@androidx.media3.common.util.UnstableApi
final class OfflineLyricsDialog extends Dialog {
  private final Activity activity;
  private final MediaController controller;
  private final String owner;
  private final Runnable loginRequired;
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final ExecutorService network = Executors.newSingleThreadExecutor();
  private final TextView title, source;
  private final LinearLayout words;
  private final ScrollView scroll;
  private final Switch sync;
  private final Button retry, followButton, play;
  private final ArrayList<TextView> lineViews = new ArrayList<>();
  private final int ink = Color.rgb(231, 237, 245), muted = Color.rgb(157, 171, 190);
  private Store.Song song;
  private JSONObject data;
  private String currentId = "";
  private boolean following = true, loading = false, closed = false;
  private int active = -1;
  private final Runnable tick = new Runnable() {
    @Override public void run() {
      if (closed) return;
      refresh();
      handler.postDelayed(this, 250);
    }
  };

  OfflineLyricsDialog(Activity activity, MediaController controller, String owner, Runnable loginRequired) {
    super(activity);
    this.activity = activity;
    this.controller = controller;
    this.owner = owner;
    this.loginRequired = loginRequired;
    requestWindowFeature(Window.FEATURE_NO_TITLE);
    LinearLayout root = new LinearLayout(activity);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(dp(16), dp(12), dp(16), dp(12));
    root.setBackgroundColor(Color.rgb(13, 17, 24));
    title = text("Текст песни", 18);
    root.addView(title);
    sync = new Switch(activity);
    sync.setText("Синхронизация");
    sync.setTextColor(ink);
    sync.setMinHeight(dp(48));
    sync.setChecked(true);
    sync.setOnCheckedChangeListener((button, checked) -> { following = true; render(); });
    root.addView(sync);
    followButton = button("К текущей строке", v -> {
      following = true;
      active = -1;
      highlight();
    });
    followButton.setVisibility(View.GONE);
    root.addView(followButton);
    scroll = new ScrollView(activity) {
      @Override public boolean onTouchEvent(MotionEvent event) {
        if (event.getActionMasked() == MotionEvent.ACTION_MOVE) {
          following = false;
          followButton.setVisibility(sync.isChecked() && sync.isEnabled() ? View.VISIBLE : View.GONE);
        }
        if (event.getActionMasked() == MotionEvent.ACTION_UP) performClick();
        return super.onTouchEvent(event);
      }

      @Override public boolean performClick() {
        return super.performClick();
      }
    };
    words = new LinearLayout(activity);
    words.setOrientation(LinearLayout.VERTICAL);
    scroll.addView(words);
    root.addView(scroll, new LinearLayout.LayoutParams(-1, 0, 1));
    source = text("", 12);
    root.addView(source);
    retry = button("Загрузить текст", v -> fetch());
    root.addView(retry);
    LinearLayout actions = new LinearLayout(activity);
    play = button("Пауза", v -> {
      if (controller.isPlaying()) controller.pause();
      else controller.play();
    });
    actions.addView(play, new LinearLayout.LayoutParams(0, dp(48), 1));
    actions.addView(button("Закрыть", v -> dismiss()), new LinearLayout.LayoutParams(0, dp(48), 1));
    root.addView(actions);
    setContentView(root);
    setOnDismissListener(dialog -> {
      closed = true;
      handler.removeCallbacks(tick);
      network.shutdownNow();
    });
  }

  @Override public void show() {
    super.show();
    Window window = getWindow();
    if (window != null) window.setLayout(-1, (int) (activity.getResources().getDisplayMetrics().heightPixels * 0.85));
    handler.post(tick);
  }

  private int dp(int value) {
    return Math.round(value * activity.getResources().getDisplayMetrics().density);
  }

  private TextView text(String value, int size) {
    TextView view = new TextView(activity);
    view.setText(value);
    view.setTextSize(size);
    view.setTextColor(ink);
    view.setPadding(dp(4), dp(8), dp(4), dp(8));
    return view;
  }

  private Button button(String value, View.OnClickListener listener) {
    Button view = new Button(activity);
    view.setText(value);
    view.setAllCaps(false);
    view.setMinHeight(dp(48));
    view.setOnClickListener(listener);
    return view;
  }

  private void refresh() {
    MediaItem item = controller.getCurrentMediaItem();
    String id = item == null ? "" : item.mediaId;
    if (!id.equals(currentId)) {
      currentId = id;
      loading = false;
      data = null;
      following = true;
      try (Store db = new Store(activity)) { song = db.song(id, owner); }
      if (song == null) { dismiss(); return; }
      title.setText(song.artist + " — " + song.title);
      try { if (song.lyrics != null) data = new JSONObject(song.lyrics); }
      catch (Exception ignored) { /* Повторная загрузка восстановит повреждённый текст. */ }
      render();
      if (data == null) fetch();
    }
    play.setText(controller.isPlaying() ? "Пауза" : "Слушать");
    boolean timed = canSync();
    if (sync.isEnabled() != timed) { sync.setEnabled(timed); render(); }
    highlight();
  }

  private boolean canSync() {
    if (data == null || !data.optBoolean("synced") || controller.getDuration() <= 0) return false;
    double duration = data.optDouble("duration_s", 0);
    return duration <= 0 || Math.abs(duration * 1000 - controller.getDuration()) <= 3000;
  }

  private void message(String value) {
    words.removeAllViews();
    lineViews.clear();
    words.addView(text(value, 18));
  }

  private void render() {
    active = -1;
    source.setText(data == null || data.isNull("source") ? "" : "Источник: " + data.optString("source", ""));
    sync.setEnabled(canSync());
    followButton.setVisibility(View.GONE);
    retry.setEnabled(!loading);
    retry.setVisibility(data != null && data.optString("status").equals("found") ? View.GONE : View.VISIBLE);
    if (data == null) { message(loading ? "Ищем текст…" : "Текст не сохранён. Подключитесь к интернету и нажмите «Загрузить текст»."); return; }
    switch (data.optString("status")) {
      case "instrumental": message("Инструментальная композиция — без слов"); return;
      case "not_found": message("Текст пока не найден. Поиск можно повторить позже."); return;
      case "temporarily_unavailable": message("Источник текстов временно недоступен. Попробуйте ещё раз."); return;
      default: break;
    }
    words.removeAllViews();
    lineViews.clear();
    if (sync.isChecked() && canSync()) {
      JSONArray lines = data.optJSONArray("lines");
      if (lines == null) return;
      for (int i = 0; i < lines.length(); i++) {
        JSONObject line = lines.optJSONObject(i);
        if (line == null) continue;
        String value = line.optString("text", "");
        boolean blank = value.trim().isEmpty();
        TextView view = text(blank ? "♪" : value, 22);
        view.setMinHeight(dp(48));
        view.setTextColor(muted);
        view.setOnClickListener(v -> {
          controller.seekTo(line.optLong("start_ms"));
          following = true;
          active = -1;
          highlight();
        });
        view.setFocusable(true);
        view.setContentDescription(blank ? "Музыкальный проигрыш" : "Перейти к строке: " + value);
        view.setEnabled(!blank);
        words.addView(view);
        lineViews.add(view);
      }
    } else {
      TextView view = text(data.optString("plain", ""), 20);
      view.setTextIsSelectable(true);
      words.addView(view);
    }
    highlight();
  }

  private void highlight() {
    if (!sync.isChecked() || !canSync() || lineViews.isEmpty()) return;
    JSONArray lines = data.optJSONArray("lines");
    if (lines == null) return;
    int next = -1;
    for (int i = 0; i < lines.length(); i++) {
      JSONObject line = lines.optJSONObject(i);
      if (line != null && line.optLong("start_ms") <= controller.getCurrentPosition()) next = i;
      else break;
    }
    if (active != next) {
      active = next;
      for (int i = 0; i < lineViews.size(); i++) {
        TextView view = lineViews.get(i);
        view.setTextColor(i == active ? ink : muted);
        view.setTypeface(null, i == active ? Typeface.BOLD : Typeface.NORMAL);
        view.setBackgroundColor(i == active ? Color.rgb(24, 56, 38) : Color.TRANSPARENT);
      }
      if (following && active >= 0 && active < lineViews.size()) {
        TextView current = lineViews.get(active);
        scroll.post(() -> { if (!closed && following) scroll.scrollTo(0, Math.max(0, current.getTop() - scroll.getHeight() / 3)); });
      }
    }
    followButton.setVisibility(!following ? View.VISIBLE : View.GONE);
  }

  private void fetch() {
    if (loading || song == null || closed) return;
    Store.Song target = song;
    loading = true;
    render();
    network.execute(() -> {
      try {
        JSONObject me = Api.me(target.base);
        if (!owner.equals(Identity.key(target.base + "|" + me.getLong("id")))) throw new Api.LoginRequired();
        String json = Api.text(target.base, "/api/lyrics?ref=" + Api.encode("nd:" + target.sid));
        JSONObject result = new JSONObject(json);
        if (!result.optString("status").equals("temporarily_unavailable")) {
          try (Store db = new Store(activity)) { db.lyrics(target, json); }
        }
        handler.post(() -> {
          if (closed || !target.id.equals(currentId)) return;
          loading = false;
          data = result;
          render();
        });
      } catch (Exception e) {
        handler.post(() -> {
          if (closed || !target.id.equals(currentId)) return;
          loading = false;
          render();
          if (e instanceof Api.LoginRequired) { dismiss(); loginRequired.run(); }
          else if (data == null) message("Нет связи. Сохранённая музыка доступна; загрузку текста можно повторить при подключении к интернету.");
        });
      }
    });
  }
}
