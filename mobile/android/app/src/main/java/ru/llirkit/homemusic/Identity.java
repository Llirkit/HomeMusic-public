package ru.llirkit.homemusic;

import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

final class Identity {
  static String origin(String input) {
    URI u = URI.create(input.trim());
    if (!"https".equalsIgnoreCase(u.getScheme())
        || u.getHost() == null
        || u.getUserInfo() != null
        || u.getQuery() != null
        || u.getFragment() != null
        || !(u.getPath().isEmpty() || u.getPath().equals("/")))
      throw new IllegalArgumentException("Укажите HTTPS-адрес сервера без пути и пароля");
    return "https://" + u.getRawAuthority().toLowerCase(java.util.Locale.ROOT);
  }

  static boolean sameOrigin(String base, String target) {
    try {
      URI a = URI.create(base), b = URI.create(target);
      return "https".equalsIgnoreCase(b.getScheme())
          && b.getUserInfo() == null
          && a.getHost().equalsIgnoreCase(b.getHost())
          && port(a) == port(b);
    } catch (Exception e) {
      return false;
    }
  }

  private static int port(URI u) {
    return u.getPort() == -1 ? 443 : u.getPort();
  }

  static String key(String text) {
    try {
      byte[] h = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
      StringBuilder s = new StringBuilder();
      for (byte b : h) s.append(String.format("%02x", b & 255));
      return s.toString();
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }
}
