package ru.llirkit.homemusic;

import java.io.IOException;

/** Validated metadata for a complete, immutable APK. */
final class UpdateRelease {
  static final long MAX_BYTES = 150L * 1024 * 1024;
  final int code;
  final String version, digest, path, notes;
  final long size;

  UpdateRelease(int code, String version, String packageName, long size, String digest,
      String path, String notes) throws IOException {
    if (code <= 0 || !version.matches("[0-9]+\\.[0-9]+\\.[0-9]+")
        || !BuildConfig.APPLICATION_ID.equals(packageName)
        || size <= 0 || size > MAX_BYTES || !digest.matches("[a-f0-9]{64}")
        || !path.equals("/app/artifacts/apk-" + digest + ".apk"))
      throw new IOException("Некорректные данные обновления");
    this.code = code;
    this.version = version;
    this.size = size;
    this.digest = digest;
    this.path = path;
    this.notes = notes.length() > 2000 ? notes.substring(0, 2000) : notes;
  }

  boolean newerThan(int installed) { return code > installed; }
}
