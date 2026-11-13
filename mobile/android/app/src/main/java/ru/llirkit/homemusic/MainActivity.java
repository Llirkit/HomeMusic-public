package ru.llirkit.homemusic;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import androidx.media3.common.*;
import androidx.media3.session.*;
import androidx.media3.session.MediaController;
import com.google.common.util.concurrent.ListenableFuture;
import java.io.*;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;

@androidx.media3.common.util.UnstableApi
public final class MainActivity extends Activity {
  private final ExecutorService network = Executors.newSingleThreadExecutor();
  private final Handler handler = new Handler(Looper.getMainLooper());
  private final int INK = Color.rgb(231, 237, 245), MUTED = Color.rgb(157, 171, 190);
  private WebView web;
  private LinearLayout offline;
  private FrameLayout pages;
  private TextView status, empty;
  private Store db;
  private android.content.SharedPreferences prefs;
  private String base, owner = "";
  private boolean offlineVisible = false, pageFailed = false;
  private List<Store.Song> rows = new ArrayList<>();
  private BaseAdapter adapter;
  private MediaController controller;
  private ListenableFuture<MediaController> controllerFuture;
  private TextView nowPlaying, playTime;
  private SeekBar seek;
  private Button playButton, previousButton, nextButton;
  private boolean seeking = false;
  private ValueCallback<Uri[]> files;
  private View webError;
  private final Runnable tick =
      new Runnable() {
        public void run() {
          if (offlineVisible) {
            refreshRows();
            refreshPlayer();
          }
          handler.postDelayed(this, 1200);
        }
      };

  private int dp(int n) {
    return Math.round(n * getResources().getDisplayMetrics().density);
  }

  private TextView text(String s, int size) {
    TextView t = new TextView(this);
    t.setText(s);
    t.setTextSize(size);
    t.setTextColor(INK);
    return t;
  }

  private Button button(String s, View.OnClickListener listener) {
    Button b = new Button(this);
    b.setText(s);
    b.setAllCaps(false);
    b.setOnClickListener(listener);
    return b;
  }

  private void toast(String s) {
    Toast.makeText(this, s, Toast.LENGTH_LONG).show();
  }

  private void ui(Runnable r) {
    runOnUiThread(
        () -> {
          if (!isFinishing() && !isDestroyed()) r.run();
        });
  }

  @Override
  public void onCreate(Bundle saved) {
    super.onCreate(saved);
    prefs = getSharedPreferences("app", MODE_PRIVATE);
    base = prefs.getString("server", BuildConfig.SERVER_URL);
    owner = prefs.getString("owner", "");
    db = new Store(this);
    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setBackgroundColor(Color.rgb(13, 17, 24));
    root.setOnApplyWindowInsetsListener(
        (v, insets) -> {
          if (Build.VERSION.SDK_INT >= 30) {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
          } else
            v.setPadding(
                insets.getSystemWindowInsetLeft(),
                insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(),
                insets.getSystemWindowInsetBottom());
          return insets;
        });
    LinearLayout header = new LinearLayout(this);
    header.setPadding(dp(12), 0, dp(8), 0);
    header.setGravity(Gravity.CENTER_VERTICAL);
    TextView title = text("HomeMusic", 20);
    header.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
    title.setGravity(Gravity.CENTER_VERTICAL);
    header.addView(button("Сервер", v -> serverDialog()));
    root.addView(header);
    pages = new FrameLayout(this);
    root.addView(pages, new LinearLayout.LayoutParams(-1, 0, 1));
    createWeb();
    createOffline();
    pages.addView(web, new FrameLayout.LayoutParams(-1, -1));
    pages.addView(offline, new FrameLayout.LayoutParams(-1, -1));
    LinearLayout tabs = new LinearLayout(this);
    tabs.setPadding(dp(8), 0, dp(8), 0);
    tabs.addView(
        button("HomeMusic", v -> showOffline(false)), new LinearLayout.LayoutParams(0, dp(56), 1));
    tabs.addView(
        button("Офлайн", v -> showOffline(true)), new LinearLayout.LayoutParams(0, dp(56), 1));
    root.addView(tabs);
    setContentView(root);
    controllerFuture =
        new MediaController.Builder(
                this, new SessionToken(this, new ComponentName(this, PlaybackService.class)))
            .buildAsync();
    controllerFuture.addListener(
        () -> {
          try {
            if (isDestroyed()) return;
            controller = controllerFuture.get();
            controller.addListener(
                new Player.Listener() {
                  @Override
                  public void onEvents(Player p, Player.Events events) {
                    refreshPlayer();
                  }

                  @Override
                  public void onPlayerError(PlaybackException error) {
                    toast("Не удалось воспроизвести файл. Скачайте песню повторно");
                  }
                });
            refreshPlayer();
          } catch (Exception e) {
            toast("Не удалось подключить плеер");
          }
        },
        this::runOnUiThread);
    if (Build.VERSION.SDK_INT >= 33) {
      getOnBackInvokedDispatcher()
          .registerOnBackInvokedCallback(
              android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::goBack);
      if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
          != PackageManager.PERMISSION_GRANTED)
        requestPermissions(new String[] {Manifest.permission.POST_NOTIFICATIONS}, 9);
    }
    web.loadUrl(base);
    showOffline(getIntent().getBooleanExtra("offline", false));
  }

  @SuppressWarnings("deprecation")
  private void createWeb() {
    web = new WebView(this);
    web.setBackgroundColor(Color.rgb(13, 17, 24));
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(true);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    // Keep the web navigation/player visible: this client does not use the legacy Tempus JS bridge.
    s.setUserAgentString(s.getUserAgentString() + " HomeMusicMobile/" + BuildConfig.VERSION_NAME);
    CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
    web.addJavascriptInterface(
        new Object() {
          @JavascriptInterface
          public void onWebPlaybackStarted() {
            ui(
                () -> {
                  if (controller != null) controller.pause();
                });
          }
        },
        "SpotikOffline");
    web.setWebViewClient(
        new WebViewClient() {
          @Override
          public void onPageStarted(WebView v, String u, android.graphics.Bitmap icon) {
            pageFailed = false;
          }

          @Override
          public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
            String u = r.getUrl().toString();
            if (Identity.sameOrigin(base, u)) return false;
            if (r.isForMainFrame() && "https".equals(r.getUrl().getScheme())) openExternal(u);
            return true;
          }

          @Override
          public void onPageFinished(WebView v, String u) {
            if (pageFailed || !Identity.sameOrigin(base, u)) return;
            hideWebError();
            v.evaluateJavascript(
                "document.addEventListener('play',function(e){if(e.target instanceof"
                    + " HTMLMediaElement)SpotikOffline.onWebPlaybackStarted()},true)",
                null);
            CookieManager.getInstance().flush();
          }

          @Override
          public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
            if (r.isForMainFrame()) {
              pageFailed = true;
              showWebError();
            }
          }
        });
    web.setWebChromeClient(
        new WebChromeClient() {
          @Override
          public boolean onShowFileChooser(
              WebView w, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (files != null) files.onReceiveValue(null);
            files = callback;
            try {
              startActivityForResult(params.createIntent(), 41);
              return true;
            } catch (Exception e) {
              files = null;
              return false;
            }
          }
        });
    web.setDownloadListener(
        (u, ua, disposition, mime, length) -> {
          if (Identity.sameOrigin(base, u)) openExternal(u);
        });
    WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
  }

  private void createOffline() {
    offline = new LinearLayout(this);
    offline.setOrientation(LinearLayout.VERTICAL);
    offline.setPadding(dp(16), dp(10), dp(16), 0);
    TextView title = text("Музыка на телефоне", 24);
    offline.addView(title);
    status = text("", 14);
    status.setTextColor(MUTED);
    status.setPadding(0, dp(8), 0, dp(8));
    offline.addView(status);
    LinearLayout actions = new LinearLayout(this);
    actions.addView(
        button("Скачать", v -> sourceDialog()), new LinearLayout.LayoutParams(0, dp(52), 1));
    actions.addView(
        button(
            "Повторить",
            v -> {
              if (owner.isEmpty()) {
                toast("Сначала войдите в HomeMusic");
                return;
              }
              db.retry(owner);
              DownloadWorker.start(this);
              refreshRows();
            }),
        new LinearLayout.LayoutParams(0, dp(52), 1));
    offline.addView(actions);
    FrameLayout listFrame = new FrameLayout(this);
    offline.addView(listFrame, new LinearLayout.LayoutParams(-1, 0, 1));
    ListView list = new ListView(this);
    list.setDividerHeight(dp(1));
    list.setChoiceMode(ListView.CHOICE_MODE_SINGLE);
    adapter =
        new BaseAdapter() {
          public int getCount() {
            return rows.size();
          }

          public Object getItem(int p) {
            return rows.get(p);
          }

          public long getItemId(int p) {
            return p;
          }

          public View getView(int p, View old, android.view.ViewGroup parent) {
            LinearLayout row = new LinearLayout(MainActivity.this);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(dp(4), dp(13), dp(4), dp(13));
            Store.Song song = rows.get(p);
            row.addView(text(song.title, 17));
            TextView artist = text(song.artist, 14);
            artist.setTextColor(MUTED);
            row.addView(artist);
            String label =
                switch (song.state) {
                  case "ready" ->
                      String.format(
                          Locale.getDefault(), "На телефоне · %.1f МБ", song.bytes / 1048576.0);
                  case "queued" -> "В очереди";
                  case "downloading" -> "Скачивается · " + song.progress + "%";
                  default -> song.error == null ? "Не удалось скачать" : song.error;
                };
            TextView info = text(label, 12);
            info.setTextColor(
                song.state.equals("failed") ? Color.rgb(255, 170, 165) : Color.rgb(139, 224, 187));
            row.addView(info);
            return row;
          }
        };
    list.setAdapter(adapter);
    list.setOnItemClickListener((a, v, p, id) -> play(rows.get(p)));
    list.setOnItemLongClickListener(
        (a, v, p, id) -> {
          removeDialog(rows.get(p));
          return true;
        });
    empty =
        text(
            "Здесь появятся сохранённые песни.\n\n"
                + "Войдите в HomeMusic и нажмите «Скачать». После сохранения музыка доступна без"
                + " интернета.",
            17);
    empty.setPadding(dp(8), dp(32), dp(8), dp(16));
    empty.setTextColor(MUTED);
    empty.setGravity(Gravity.CENTER);
    listFrame.addView(list, new FrameLayout.LayoutParams(-1, -1));
    listFrame.addView(empty, new FrameLayout.LayoutParams(-1, -1));
    list.setEmptyView(empty);
    LinearLayout playerBox = new LinearLayout(this);
    playerBox.setOrientation(LinearLayout.VERTICAL);
    playerBox.setPadding(dp(8), dp(10), dp(8), dp(8));
    playerBox.setBackgroundColor(Color.rgb(21, 30, 41));
    nowPlaying = text("Выберите сохранённую песню", 15);
    nowPlaying.setMaxLines(2);
    nowPlaying.setEllipsize(android.text.TextUtils.TruncateAt.END);
    playerBox.addView(nowPlaying);
    seek = new SeekBar(this);
    seek.setMax(1000);
    seek.setContentDescription("Позиция в песне");
    playerBox.addView(seek, new LinearLayout.LayoutParams(-1, dp(36)));
    playTime = text("0:00 / 0:00", 12);
    playTime.setTextColor(MUTED);
    playerBox.addView(playTime);
    seek.setOnSeekBarChangeListener(
        new SeekBar.OnSeekBarChangeListener() {
          public void onStartTrackingTouch(SeekBar s) {
            seeking = true;
          }

          public void onProgressChanged(SeekBar s, int value, boolean user) {
            if (user && controller != null && controller.getDuration() > 0)
              playTime.setText(
                  clock(controller.getDuration() * value / 1000)
                      + " / "
                      + clock(controller.getDuration()));
          }

          public void onStopTrackingTouch(SeekBar s) {
            if (controller != null && controller.getDuration() > 0)
              controller.seekTo(controller.getDuration() * s.getProgress() / 1000);
            seeking = false;
          }
        });
    LinearLayout buttons = new LinearLayout(this);
    previousButton =
        button(
            "Назад",
            v -> {
              if (controller != null) controller.seekToPreviousMediaItem();
            });
    previousButton.setContentDescription("Предыдущая песня");
    playButton =
        button(
            "Слушать",
            v -> {
              if (controller == null) return;
              if (controller.isPlaying()) controller.pause();
              else {
                if (controller.getPlaybackState() == Player.STATE_ENDED) controller.seekTo(0);
                controller.play();
              }
            });
    nextButton =
        button(
            "Далее",
            v -> {
              if (controller != null) controller.seekToNextMediaItem();
            });
    nextButton.setContentDescription("Следующая песня");
    for (Button b : new Button[] {previousButton, playButton, nextButton})
      buttons.addView(b, new LinearLayout.LayoutParams(0, dp(48), 1));
    playerBox.addView(buttons);
    offline.addView(playerBox);
    refreshPlayer();
  }

  private static String clock(long millis) {
    long seconds = Math.max(0, millis) / 1000;
    return String.format(Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60);
  }

  private void refreshPlayer() {
    if (playButton == null) return;
    boolean loaded = controller != null && controller.getCurrentMediaItem() != null;
    playButton.setEnabled(loaded);
    previousButton.setEnabled(loaded && controller.hasPreviousMediaItem());
    nextButton.setEnabled(loaded && controller.hasNextMediaItem());
    if (!loaded) {
      nowPlaying.setText("Выберите сохранённую песню");
      seek.setEnabled(false);
      return;
    }
    MediaMetadata m = controller.getMediaMetadata();
    nowPlaying.setText(
        (m.artist == null ? "" : m.artist + " — ") + (m.title == null ? "Музыка" : m.title));
    playButton.setText(controller.isPlaying() ? "Пауза" : "Слушать");
    long duration = Math.max(0, controller.getDuration()),
        position = Math.max(0, controller.getCurrentPosition());
    seek.setEnabled(duration > 0);
    if (!seeking) {
      seek.setProgress(duration > 0 ? (int) (position * 1000 / duration) : 0);
      playTime.setText(clock(position) + " / " + clock(duration));
    }
  }

  private void refreshRows() {
    if (db == null) return;
    rows = owner.isEmpty() ? new ArrayList<>() : db.songs(owner);
    adapter.notifyDataSetChanged();
    int ready = 0, pending = 0;
    long size = 0;
    for (Store.Song s : rows) {
      if (s.state.equals("ready")) {
        ready++;
        size += s.bytes;
      }
      if (s.state.equals("queued") || s.state.equals("downloading")) pending++;
    }
    status.setText(
        (owner.isEmpty() ? "Войдите в аккаунт" : prefs.getString("username", ""))
            + " · "
            + ready
            + " сохранено · "
            + String.format(Locale.getDefault(), "%.1f МБ", size / 1048576.0)
            + (pending > 0 ? " · в очереди: " + pending : ""));
  }

  private void showOffline(boolean show) {
    offlineVisible = show;
    offline.setVisibility(show ? View.VISIBLE : View.GONE);
    web.setVisibility(show ? View.GONE : View.VISIBLE);
    if (webError != null) webError.setVisibility(show ? View.GONE : View.VISIBLE);
    if (show) {
      refreshRows();
      String server = base;
      network.execute(
          () -> {
            try {
              remember(server, Api.me(server));
            } catch (Api.LoginRequired e) {
              if (base.equals(server)) clearAccount();
            } catch (Exception ignored) {
              /* Last verified account remains usable without a network. */
            }
          });
    }
  }

  private void remember(String server, JSONObject me) throws JSONException {
    String name = me.getString("username");
    String verified = Identity.key(server + "|" + me.getLong("id"));
    ui(
        () -> {
          if (!base.equals(server)) return;
          if (!owner.equals(verified) && controller != null) {
            controller.pause();
            controller.clearMediaItems();
          }
          owner = verified;
          prefs.edit().putString("owner", owner).putString("username", name).apply();
          refreshRows();
        });
  }

  private void clearAccount() {
    ui(
        () -> {
          owner = "";
          prefs.edit().remove("owner").remove("username").apply();
          if (controller != null) {
            controller.pause();
            controller.clearMediaItems();
          }
          refreshRows();
        });
  }

  private interface Fetch {
    void run() throws Exception;
  }

  private void request(Fetch action) {
    status.setText("Загрузка списка…");
    network.execute(
        () -> {
          try {
            action.run();
          } catch (Exception e) {
            ui(
                () -> {
                  if (e instanceof Api.LoginRequired) clearAccount();
                  refreshRows();
                  toast(
                      e instanceof Api.LoginRequired
                          ? e.getMessage()
                          : "Не удалось получить список. Проверьте интернет и повторите");
                });
          }
        });
  }

  private void sourceDialog() {
    String server = base;
    new AlertDialog.Builder(this)
        .setTitle("Сохранить на телефон")
        .setItems(
            new String[] {"Выбрать песни из микса дня", "Выбрать плейлист"},
            (d, which) ->
                request(
                    () -> {
                      JSONObject me = Api.me(server);
                      String batchOwner = Identity.key(server + "|" + me.getLong("id"));
                      remember(server, me);
                      if (!base.equals(server)) return;
                      if (which == 0) {
                        JSONObject current = new JSONObject(Api.text(server, "/api/mixes/today"));
                        JSONObject mix = current.optJSONObject("mix");
                        if (mix == null) {
                          ui(() -> toast("Микса пока нет. Соберите его на вкладке HomeMusic"));
                          return;
                        }
                        JSONArray tracks = mix.getJSONArray("tracks");
                        ui(
                            () ->
                                chooseTracks(
                                    mix.optString("title", "Микс дня"), tracks, batchOwner));
                      } else {
                        JSONArray pls = new JSONArray(Api.text(server, "/api/playlists"));
                        String[] names = new String[pls.length()];
                        for (int i = 0; i < names.length; i++)
                          names[i] = pls.getJSONObject(i).optString("name", "Плейлист");
                        ui(
                            () -> {
                              if (names.length == 0) {
                                toast("Сначала создайте плейлист в HomeMusic");
                                return;
                              }
                              new AlertDialog.Builder(this)
                                  .setTitle("Плейлист")
                                  .setItems(
                                      names,
                                      (dialog, index) ->
                                          request(
                                              () -> {
                                                JSONObject pl =
                                                    new JSONObject(
                                                        Api.text(
                                                            server,
                                                            "/api/playlists/"
                                                                + Api.encode(
                                                                    pls.getJSONObject(index)
                                                                        .getString("id"))));
                                                ui(
                                                    () -> {
                                                      try {
                                                        chooseTracks(
                                                            names[index],
                                                            pl.getJSONArray("tracks"),
                                                            batchOwner);
                                                      } catch (JSONException e) {
                                                        toast("Не удалось прочитать плейлист");
                                                      }
                                                    });
                                              }))
                                  .setNegativeButton("Назад", null)
                                  .show();
                            });
                      }
                    }))
        .setNegativeButton("Отмена", null)
        .show();
  }

  private void chooseTracks(String title, JSONArray tracks, String batchOwner) {
    ArrayList<JSONObject> available = new ArrayList<>();
    for (int i = 0; i < tracks.length(); i++) {
      JSONObject t = tracks.optJSONObject(i);
      if (t != null
          && !t.optString("nd_song_id", "").trim().isEmpty()
          && !t.optString("nd_song_id").equals("null")) available.add(t);
    }
    if (available.isEmpty()) {
      toast("Дождитесь загрузки песен на сервер");
      return;
    }
    JSONArray songs = new JSONArray(available);
    String[] labels = new String[songs.length()];
    boolean[] selected = new boolean[labels.length];
    Arrays.fill(selected, true);
    for (int i = 0; i < labels.length; i++) {
      JSONObject t = songs.optJSONObject(i);
      labels[i] = t.optString("artist") + " — " + t.optString("title");
    }
    new AlertDialog.Builder(this)
        .setTitle(title + " · " + songs.length())
        .setMultiChoiceItems(labels, selected, (dialog, i, checked) -> selected[i] = checked)
        .setNeutralButton(
            "Снять выбор",
            (d, w) -> {
              Arrays.fill(selected, false);
              selectAgain(title, songs, batchOwner, labels, selected);
            })
        .setPositiveButton("Скачать", (d, w) -> enqueue(songs, selected, batchOwner))
        .setNegativeButton("Отмена", null)
        .show();
    refreshRows();
  }

  private void selectAgain(
      String title, JSONArray songs, String batchOwner, String[] labels, boolean[] selected) {
    new AlertDialog.Builder(this)
        .setTitle(title)
        .setMultiChoiceItems(labels, selected, (d, i, c) -> selected[i] = c)
        .setPositiveButton("Скачать", (d, w) -> enqueue(songs, selected, batchOwner))
        .setNegativeButton("Отмена", null)
        .show();
  }

  private void enqueue(JSONArray songs, boolean[] selected, String batchOwner) {
    if (!batchOwner.equals(owner)) {
      toast("Аккаунт изменился. Откройте список заново");
      return;
    }
    try {
      int n = db.enqueue(owner, base, songs, selected);
      if (n > 0) {
        DownloadWorker.start(this);
        toast("Добавлено в загрузки: " + n);
      } else toast("Выбранные песни уже сохранены или не выбраны");
      refreshRows();
    } catch (Exception e) {
      toast("Не удалось добавить загрузку");
    }
  }

  private void play(Store.Song selected) {
    if (!selected.state.equals("ready")) {
      toast(selected.error == null ? "Песня ещё не сохранена" : selected.error);
      return;
    }
    if (controller == null) {
      toast("Плеер подключается. Повторите через секунду");
      return;
    }
    web.evaluateJavascript(
        "document.querySelectorAll('audio,video').forEach(function(x){x.pause()})", null);
    List<MediaItem> queue = new ArrayList<>();
    int index = 0;
    for (Store.Song song : rows)
      if (song.state.equals("ready") && new File(song.file).isFile()) {
        if (song.id.equals(selected.id)) index = queue.size();
        queue.add(
            new MediaItem.Builder()
                .setMediaId(song.id)
                .setUri(Uri.fromFile(new File(song.file)))
                .setMimeType(song.mime)
                .setMediaMetadata(
                    new MediaMetadata.Builder().setTitle(song.title).setArtist(song.artist).build())
                .build());
      }
    if (queue.isEmpty()) {
      toast("Файл не найден. Скачайте песню повторно");
      return;
    }
    controller.setMediaItems(queue, index, 0);
    controller.prepare();
    controller.play();
  }

  private void removeDialog(Store.Song song) {
    if (song.state.equals("queued") || song.state.equals("downloading")) {
      toast("Дождитесь завершения загрузки");
      return;
    }
    new AlertDialog.Builder(this)
        .setTitle("Удалить с телефона?")
        .setMessage(song.artist + " — " + song.title + "\nНа сервере песня останется.")
        .setNegativeButton("Отмена", null)
        .setPositiveButton(
            "Удалить",
            (d, w) -> {
              if (controller != null) {
                controller.pause();
                controller.clearMediaItems();
              }
              try {
                db.delete(song);
                refreshRows();
              } catch (IOException e) {
                toast(e.getMessage());
              }
            })
        .show();
  }

  private void serverDialog() {
    EditText field = new EditText(this);
    field.setSingleLine();
    field.setText(base);
    field.setInputType(
        android.text.InputType.TYPE_CLASS_TEXT | android.text.InputType.TYPE_TEXT_VARIATION_URI);
    AlertDialog d =
        new AlertDialog.Builder(this)
            .setTitle("Сервер HomeMusic")
            .setMessage("HTTPS-адрес. При смене сервера потребуется войти заново.")
            .setView(field)
            .setPositiveButton("Сохранить", null)
            .setNegativeButton("Отмена", null)
            .create();
    d.setOnShowListener(
        x ->
            d.getButton(AlertDialog.BUTTON_POSITIVE)
                .setOnClickListener(
                    v -> {
                      try {
                        String next = Identity.origin(field.getText().toString());
                        if (!next.equals(base)) {
                          clearAccount();
                          base = next;
                          prefs.edit().putString("server", base).apply();
                          CookieManager.getInstance().removeAllCookies(done -> web.loadUrl(base));
                        }
                        d.dismiss();
                      } catch (Exception e) {
                        field.setError(
                            "Введите HTTPS-адрес без пути, например https://spotik.llirkit.ru");
                      }
                    }));
    d.show();
  }

  private void openExternal(String url) {
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
    } catch (Exception e) {
      toast("Не найден браузер для открытия ссылки");
    }
  }

  private void showWebError() {
    if (webError != null) return;
    LinearLayout box = new LinearLayout(this);
    box.setOrientation(LinearLayout.VERTICAL);
    box.setGravity(Gravity.CENTER);
    box.setPadding(dp(24), dp(24), dp(24), dp(24));
    box.setBackgroundColor(Color.rgb(13, 17, 24));
    box.addView(text("Нет соединения с HomeMusic", 22));
    box.addView(
        text("Проверьте интернет или откройте сохранённую музыку на вкладке «Офлайн».", 16));
    box.addView(
        button(
            "Повторить",
            v -> {
              hideWebError();
              web.loadUrl(base);
            }));
    webError = box;
    pages.addView(box, new FrameLayout.LayoutParams(-1, -1));
    if (offlineVisible) box.setVisibility(View.GONE);
  }

  private void hideWebError() {
    if (webError != null) {
      pages.removeView(webError);
      webError = null;
    }
  }

  private void goBack() {
    if (offlineVisible) showOffline(false);
    else if (web.canGoBack()) web.goBack();
    else finish();
  }

  // API 33+ uses the registered OnBackInvokedDispatcher; this override serves Android 8–12 only.
  @android.annotation.SuppressLint("GestureBackNavigation")
  @Override
  public void onBackPressed() {
    goBack();
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request == 41 && files != null) {
      files.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data));
      files = null;
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    handler.post(tick);
  }

  @Override
  protected void onPause() {
    handler.removeCallbacks(tick);
    super.onPause();
  }

  @Override
  protected void onDestroy() {
    handler.removeCallbacks(tick);
    if (files != null) files.onReceiveValue(null);
    network.shutdownNow();
    if (controllerFuture != null) MediaController.releaseFuture(controllerFuture);
    if (web != null) web.destroy();
    if (db != null) db.close();
    super.onDestroy();
  }
}
