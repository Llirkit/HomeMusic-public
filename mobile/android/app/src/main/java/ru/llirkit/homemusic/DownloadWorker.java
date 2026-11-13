package ru.llirkit.homemusic;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.media.MediaMetadataRetriever;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.work.*;
import java.io.*;
import java.net.HttpURLConnection;
import java.nio.file.*;
import org.json.JSONObject;

@androidx.media3.common.util.UnstableApi
public final class DownloadWorker extends Worker {
  static final String NAME = "offline-downloads";

  public DownloadWorker(@NonNull Context c, @NonNull WorkerParameters p) {
    super(c, p);
  }

  static void start(Context c) {
    WorkManager.getInstance(c)
        .enqueueUniqueWork(
            NAME,
            ExistingWorkPolicy.APPEND_OR_REPLACE,
            new OneTimeWorkRequest.Builder(DownloadWorker.class)
                .setConstraints(
                    new Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build());
  }

  private ForegroundInfo foreground(String text) {
    Context c = getApplicationContext();
    NotificationManager n = c.getSystemService(NotificationManager.class);
    n.createNotificationChannel(
        new NotificationChannel(
            "downloads", "Сохранение музыки", NotificationManager.IMPORTANCE_LOW));
    PendingIntent open =
        PendingIntent.getActivity(
            c,
            0,
            new Intent(c, MainActivity.class).putExtra("offline", true),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    Notification notification =
        new Notification.Builder(c, "downloads")
            .setSmallIcon(R.drawable.ic_music)
            .setContentTitle("HomeMusic · офлайн")
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build();
    return Build.VERSION.SDK_INT >= 29
        ? new ForegroundInfo(80, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        : new ForegroundInfo(80, notification);
  }

  @NonNull
  @Override
  public Result doWork() {
    Context c = getApplicationContext();
    try {
      setForegroundAsync(foreground("Подготовка загрузки")).get();
    } catch (Exception e) {
      return Result.retry();
    }
    try (Store db = new Store(c)) {
      db.recover();
      Store.Song song;
      while (!isStopped() && (song = db.claim()) != null) {
        File partial = new File(song.file + ".part");
        HttpURLConnection connection = null;
        try {
          JSONObject me = Api.me(song.base);
          String owner = Identity.key(song.base + "|" + me.getLong("id"));
          if (!owner.equals(song.owner))
            throw new IOException("Войдите в аккаунт, для которого добавлена эта песня");
          setForegroundAsync(foreground(song.artist + " — " + song.title));
          connection =
              Api.open(
                  song.base,
                  "/api/listen/stream?ref=" + Api.encode("nd:" + song.sid) + "&full=true");
          String mime = connection.getContentType();
          if (mime == null
              || !(mime.startsWith("audio/")
                  || mime.contains("ogg")
                  || mime.contains("octet-stream")))
            throw new IOException("Сервер не вернул аудиофайл");
          long expected = connection.getContentLengthLong(), size = 0;
          int percent = -1;
          if (expected > 256L * 1024 * 1024)
            throw new IOException("Файл превышает ограничение 256 МБ");
          if (new File(song.file).getParentFile().getUsableSpace()
              < Math.max(expected, 32L * 1024 * 1024) + 16L * 1024 * 1024)
            throw new IOException("Недостаточно места на телефоне");
          try (InputStream in = connection.getInputStream();
              FileOutputStream out = new FileOutputStream(partial)) {
            byte[] b = new byte[65536];
            int n;
            while ((n = in.read(b)) != -1) {
              if (isStopped()) throw new IOException("Загрузка прервана — нажмите «Повторить»");
              out.write(b, 0, n);
              size += n;
              if (size > 256L * 1024 * 1024)
                throw new IOException("Файл превышает ограничение 256 МБ");
              int p = expected > 0 ? (int) (size * 100 / expected) : 0;
              if (p != percent) {
                db.progress(song.id, p);
                percent = p;
              }
            }
            out.getFD().sync();
          }
          if (size < 256 || (expected > 0 && size != expected))
            throw new IOException("Файл скачался не полностью");
          MediaMetadataRetriever info = new MediaMetadataRetriever();
          try {
            info.setDataSource(partial.getAbsolutePath());
            String duration = info.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION);
            if (duration == null || Long.parseLong(duration) <= 0)
              throw new IOException("Не удалось проверить аудиофайл");
          } finally {
            info.release();
          }
          Files.move(
              partial.toPath(), new File(song.file).toPath(), StandardCopyOption.REPLACE_EXISTING);
          db.ready(song, mime, size);
          // Текст необязателен: его отсутствие или ошибка не отменяют сохранённое аудио.
          try {
            String lyrics = Api.text(song.base, "/api/lyrics?ref=" + Api.encode("nd:" + song.sid));
            JSONObject result = new JSONObject(lyrics);
            if (!result.optString("status").equals("temporarily_unavailable")) db.lyrics(song, lyrics);
          } catch (Exception ignored) {
            // Получение можно повторить кнопкой «Текст песни» при наличии сети.
          }
        } catch (Exception e) {
          partial.delete();
          String message =
              e instanceof Api.LoginRequired
                  ? e.getMessage()
                  : e instanceof IOException
                      ? e.getMessage()
                      : "Не удалось сохранить аудио. Повторите загрузку";
          db.failed(song.id, message == null ? "Ошибка загрузки" : message);
        } finally {
          if (connection != null) connection.disconnect();
        }
      }
    }
    return Result.success();
  }
}
