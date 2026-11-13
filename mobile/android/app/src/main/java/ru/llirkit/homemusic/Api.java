package ru.llirkit.homemusic;

import android.webkit.CookieManager;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class Api {
  static final class LoginRequired extends IOException {
    LoginRequired() {
      super("Войдите в аккаунт на вкладке HomeMusic");
    }
  }

  static HttpURLConnection open(String base, String path) throws IOException {
    String address = base + path;
    for (int n = 0; n < 4; n++) {
      if (!Identity.sameOrigin(base, address))
        throw new IOException("Сервер перенаправил запрос на другой адрес");
      HttpURLConnection c = (HttpURLConnection) new URL(address).openConnection();
      c.setConnectTimeout(15000);
      c.setReadTimeout(30000);
      c.setInstanceFollowRedirects(false);
      String cookie = CookieManager.getInstance().getCookie(base);
      if (cookie != null) c.setRequestProperty("Cookie", cookie);
      c.setRequestProperty("User-Agent", "HomeMusicOffline/" + BuildConfig.VERSION_NAME);
      int status = c.getResponseCode();
      if (status == 401 || status == 403) {
        c.disconnect();
        throw new LoginRequired();
      }
      if (status >= 300 && status < 400) {
        String next = c.getHeaderField("Location");
        c.disconnect();
        if (next == null) throw new IOException("Пустое перенаправление");
        address = new URL(new URL(address), next).toString();
        continue;
      }
      if (status < 200 || status >= 300) {
        c.disconnect();
        throw new IOException("Сервер ответил HTTP " + status);
      }
      return c;
    }
    throw new IOException("Слишком много перенаправлений");
  }

  static String text(String base, String path) throws IOException {
    HttpURLConnection c = open(base, path);
    try (InputStream in = c.getInputStream();
        ByteArrayOutputStream out = new ByteArrayOutputStream()) {
      byte[] b = new byte[8192];
      int n;
      while ((n = in.read(b)) != -1) {
        out.write(b, 0, n);
        if (out.size() > 8 * 1024 * 1024) throw new IOException("Слишком большой ответ");
      }
      return out.toString(StandardCharsets.UTF_8.name());
    } finally {
      c.disconnect();
    }
  }

  static JSONObject me(String base) throws Exception {
    return new JSONObject(text(base, "/api/auth/me"));
  }

  static String encode(String value) {
    try {
      return URLEncoder.encode(value, "UTF-8");
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }
}
