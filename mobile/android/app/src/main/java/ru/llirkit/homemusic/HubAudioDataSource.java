package ru.llirkit.homemusic;

import android.net.Uri;
import androidx.media3.common.C;
import androidx.media3.datasource.BaseDataSource;
import androidx.media3.datasource.DataSpec;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.util.function.Supplier;

/** Cookies stay on the configured HTTPS Hub, including every redirect and Range request. */
@androidx.media3.common.util.UnstableApi
final class HubAudioDataSource extends BaseDataSource {
  private final String base;
  private final Supplier<String> currentStream;
  private HttpURLConnection connection;
  private InputStream input;
  private Uri uri;
  private long remaining;
  private boolean opened;

  HubAudioDataSource(String base, Supplier<String> currentStream) { super(true); this.base = base; this.currentStream = currentStream; }

  @Override public long open(DataSpec spec) throws IOException {
    transferInitializing(spec);
    uri = spec.uri;
    if (!Identity.sameOrigin(base, uri.toString())) throw new IOException("Недопустимый адрес аудио");
    String range = spec.position > 0 || spec.length != C.LENGTH_UNSET
        ? "bytes=" + spec.position + "-" + (spec.length == C.LENGTH_UNSET ? "" : spec.position + spec.length - 1) : null;
    connection = Api.open(base, uri.toString().substring(base.length()), range, 120000, !uri.toString().equals(currentStream.get()));
    try {
      input = connection.getInputStream();
      long skipped = connection.getResponseCode() == 200 ? spec.position : 0;
      for (long left = skipped; left > 0;) {
        long n = input.skip(left);
        if (n == 0) { if (input.read() < 0) throw new IOException("Позиция вне аудиофайла"); n = 1; }
        left -= n;
      }
      long length = connection.getContentLengthLong();
      remaining = spec.length != C.LENGTH_UNSET ? spec.length : length < 0 ? C.LENGTH_UNSET : Math.max(0, length - skipped);
      opened = true;
      transferStarted(spec);
      return remaining;
    } catch (IOException e) { close(); throw e; }
  }

  @Override public int read(byte[] buffer, int offset, int length) throws IOException {
    if (length == 0) return 0;
    if (remaining == 0) return C.RESULT_END_OF_INPUT;
    int n = input.read(buffer, offset, remaining == C.LENGTH_UNSET ? length : (int) Math.min(length, remaining));
    if (n < 0) return C.RESULT_END_OF_INPUT;
    if (remaining != C.LENGTH_UNSET) remaining -= n;
    bytesTransferred(n);
    return n;
  }

  @Override public Uri getUri() { return uri; }
  @Override public void close() throws IOException {
    try { if (input != null) input.close(); }
    finally {
      input = null;
      if (connection != null) connection.disconnect();
      connection = null;
      uri = null;
      if (opened) { opened = false; transferEnded(); }
    }
  }
}
