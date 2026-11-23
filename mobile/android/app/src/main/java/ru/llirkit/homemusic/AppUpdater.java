package ru.llirkit.homemusic;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import java.io.*;
import java.net.HttpURLConnection;
import java.security.MessageDigest;
import java.util.*;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Native updater. Playback continues during download; installation is user initiated. */
final class AppUpdater implements AutoCloseable {
  private final Activity activity;
  private final String server;
  private final SharedPreferences prefs;
  private final ExecutorService executor = Executors.newSingleThreadExecutor();
  private volatile boolean closed;
  private boolean busy, resumed, pendingPermission, wanted, reportCheck;
  private AlertDialog dialog;
  private UpdateRelease release;
  private File apk;
  private String message = "", action = "";
  private Runnable primary;
  private final String checkKey;

  AppUpdater(Activity activity, String server) {
    this.activity = activity;
    this.server = server;
    prefs = activity.getSharedPreferences("app", Activity.MODE_PRIVATE);
    checkKey = "update_checked_" + Identity.key(server);
  }

  void resume() {
    resumed = true;
    if (pendingPermission) {
      pendingPermission = false;
      if (activity.getPackageManager().canRequestPackageInstalls()) install();
      else state("Установка не разрешена. Разрешите HomeMusic устанавливать обновления и повторите.",
          "Разрешить", this::install, true);
      return;
    }
    if (wanted) render();
    long elapsed = System.currentTimeMillis() - prefs.getLong(checkKey, 0);
    if (!busy && release == null && (elapsed < 0 || elapsed >= TimeUnit.HOURS.toMillis(6))) check(false);
  }

  void pause() { resumed = false; dismiss(); }

  void show() {
    wanted = true;
    reportCheck = true;
    if (busy || release != null) { render(); return; }
    check(true);
  }

  private void check(boolean manual) {
    if (busy || closed) return;
    busy = true;
    reportCheck = manual;
    state("Проверяем наличие новой версии…", "", null, manual);
    prefs.edit().putLong(checkKey, System.currentTimeMillis()).apply();
    executor.execute(() -> {
      try {
        JSONObject data = new JSONObject(Api.text(server, "/app/latest.json"));
        JSONObject full = data.getJSONObject("full");
        UpdateRelease found = new UpdateRelease(data.getInt("versionCode"), data.getString("versionName"),
            data.getString("packageName"), data.getLong("size"), data.getString("sha256"),
            full.getString("url"), data.optString("notes"));
        if (full.getLong("size") != found.size || !full.getString("sha256").equals(found.digest))
          throw new IOException("Некорректный файл обновления");
        ui(() -> {
          busy = false;
          if (found.newerThan(BuildConfig.VERSION_CODE)) {
            release = found;
            state("Доступна версия " + found.version + " · "
                + String.format(Locale.getDefault(), "%.1f МБ", found.size / 1048576d)
                + (found.notes.isEmpty() ? "" : "\n\n" + found.notes), "Скачать", this::download, true);
          } else if (reportCheck) state("Установлена актуальная версия " + BuildConfig.VERSION_NAME,
              "Проверить ещё раз", () -> check(true), true);
        });
      } catch (Exception e) {
        ui(() -> {
          busy = false;
          if (reportCheck) state("Не удалось проверить обновления. Проверьте интернет и повторите.",
              "Повторить", () -> check(true), true);
        });
      }
    });
  }

  private void download() {
    if (busy || release == null || closed) return;
    busy = true;
    UpdateRelease target = release;
    state("Скачиваем обновление · 0%", "", null, true);
    executor.execute(() -> {
      File directory = new File(activity.getCacheDir(), "updates/" + Identity.key(server));
      File complete = new File(directory, target.digest + ".apk");
      File partial = null;
      try {
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Нет места для обновления");
        if (!complete.isFile()) {
          partial = File.createTempFile(target.digest, ".part", directory);
          HttpURLConnection connection = Api.open(server, target.path);
          try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(partial)) {
            byte[] buffer = new byte[65536];
            long count = 0;
            int n, last = -1;
            while ((n = in.read(buffer)) != -1) {
              if (closed || Thread.currentThread().isInterrupted()) throw new InterruptedIOException();
              count += n;
              if (count > target.size) throw new IOException("Неверный размер обновления");
              out.write(buffer, 0, n);
              int percent = (int) (100 * count / target.size);
              if (percent != last) {
                last = percent;
                ui(() -> state("Скачиваем обновление · " + percent + "%", "", null, false));
              }
            }
          } finally { connection.disconnect(); }
          verify(partial, target);
          if (!partial.renameTo(complete)) throw new IOException("Не удалось сохранить обновление");
        }
        try { verify(complete, target); }
        catch (InterruptedIOException e) { throw e; }
        catch (Exception e) { complete.delete(); throw e; }
        ui(() -> {
          busy = false;
          apk = complete;
          state("Версия " + target.version + " скачана и проверена.\n\n"
              + "Android попросит подтвердить обновление. Скачанная музыка и вход сохранятся.",
              "Установить", this::install, true);
        });
      } catch (Exception e) {
        if (partial != null) partial.delete();
        ui(() -> {
          busy = false;
          state("Не удалось скачать или проверить обновление. Проверьте интернет и свободное место и повторите.",
              "Повторить", this::download, true);
        });
      }
    });
  }

  @SuppressWarnings("deprecation")
  private void verify(File file, UpdateRelease target) throws Exception {
    if (file.length() != target.size) throw new IOException("Неверный размер APK");
    MessageDigest hash = MessageDigest.getInstance("SHA-256");
    try (InputStream in = new FileInputStream(file)) {
      byte[] buffer = new byte[65536];
      int n;
      while ((n = in.read(buffer)) != -1) {
        if (closed || Thread.currentThread().isInterrupted()) throw new InterruptedIOException();
        hash.update(buffer, 0, n);
      }
    }
    StringBuilder digest = new StringBuilder();
    for (byte b : hash.digest()) digest.append(String.format(Locale.ROOT, "%02x", b & 255));
    if (!digest.toString().equals(target.digest)) throw new IOException("Повреждённый APK");
    PackageManager pm = activity.getPackageManager();
    int flags = Build.VERSION.SDK_INT >= 28 ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
    PackageInfo candidate = pm.getPackageArchiveInfo(file.getAbsolutePath(), flags);
    PackageInfo installed = pm.getPackageInfo(activity.getPackageName(), flags);
    if (candidate == null || !activity.getPackageName().equals(candidate.packageName)
        || (Build.VERSION.SDK_INT >= 28 ? candidate.getLongVersionCode() : candidate.versionCode) != target.code
        || !target.version.equals(candidate.versionName)
        || !signers(candidate).equals(signers(installed)) || signers(candidate).isEmpty())
      throw new IOException("APK не соответствует установленному приложению");
  }

  @SuppressWarnings("deprecation")
  private static Set<Signature> signers(PackageInfo info) {
    Signature[] signatures = Build.VERSION.SDK_INT >= 28
        ? (info.signingInfo == null ? null : info.signingInfo.getApkContentsSigners()) : info.signatures;
    return signatures == null ? Collections.emptySet() : new HashSet<>(Arrays.asList(signatures));
  }

  private void install() {
    if (apk == null || !apk.isFile()) { download(); return; }
    if (!activity.getPackageManager().canRequestPackageInstalls()) {
      new AlertDialog.Builder(activity).setTitle("Разрешите обновление HomeMusic")
          .setMessage("В следующем окне включите «Разрешить установку из этого источника», затем вернитесь в HomeMusic.")
          .setNegativeButton("Позже", null).setPositiveButton("Открыть настройки", (d, w) -> {
            try {
              pendingPermission = true;
              activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                  Uri.parse("package:" + activity.getPackageName())));
            } catch (ActivityNotFoundException e) {
              pendingPermission = false;
              Toast.makeText(activity, "Откройте разрешение на установку в настройках Android", Toast.LENGTH_LONG).show();
            }
          }).show();
      return;
    }
    try {
      Uri uri = FileProvider.getUriForFile(activity, activity.getPackageName() + ".updates", apk);
      activity.startActivity(new Intent(Intent.ACTION_VIEW).setDataAndType(uri,
          "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION));
    } catch (ActivityNotFoundException | IllegalArgumentException e) {
      state("Не удалось открыть установщик Android. Повторите установку.", "Установить", this::install, true);
    }
  }

  private void ui(Runnable task) {
    activity.runOnUiThread(() -> { if (!closed && !activity.isDestroyed() && !activity.isFinishing()) task.run(); });
  }

  private void state(String text, String label, Runnable callback, boolean show) {
    message = text;
    action = label;
    primary = callback;
    if (show) { wanted = true; render(); }
    else if (dialog != null) dialog.setMessage(message);
  }

  private void render() {
    if (!resumed || closed || !wanted) return;
    dismiss();
    AlertDialog.Builder builder = new AlertDialog.Builder(activity)
        .setTitle("Обновление HomeMusic · " + BuildConfig.VERSION_NAME).setMessage(message)
        .setNegativeButton(busy ? "Скрыть" : "Позже", (d, w) -> { });
    if (primary != null) builder.setPositiveButton(action, (d, w) -> primary.run());
    dialog = builder.create();
    dialog.setOnDismissListener(d -> { if (dialog == d) { dialog = null; wanted = false; } });
    dialog.show();
  }

  private void dismiss() {
    AlertDialog previous = dialog;
    dialog = null;
    if (previous != null) previous.dismiss();
  }

  @Override public void close() {
    closed = true;
    dismiss();
    executor.shutdownNow();
  }
}
